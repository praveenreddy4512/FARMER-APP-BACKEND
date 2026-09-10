const express = require('express');
const { supabase } = require('./supabase');
const { findProfile, requirePhoneEmailUser } = require('./auth');

const ACTION_TYPES = new Set([
  'ADD_CROP', 'UPDATE_CROP', 'ADD_CROP_UPDATE', 'ADD_EXPENSE', 'SET_BUDGET',
  'ADD_CALENDAR_EVENT', 'GET_EXPENSE_SUMMARY', 'GET_BUDGET_SUMMARY',
  'GET_CROP_SUMMARY', 'GET_CALENDAR', 'MULTIPLE_ACTIONS', 'UNKNOWN',
]);
const LANGUAGES = new Set(['en', 'hi', 'te']);
const CATEGORIES = new Set(['fertilizer', 'labor', 'irrigation', 'pesticide', 'seed', 'equipment', 'transport', 'other']);
const EVENT_TYPES = new Set(['planting', 'irrigation', 'fertilizer', 'pesticide', 'weeding', 'harvest', 'expense', 'crop_update', 'general_reminder']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_LENGTH = 4000;

function errorResponse(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function createRateLimiter({ windowMs = 60_000, max = 10 } = {}) {
  const attempts = new Map();
  return (req, res, next) => {
    const key = req.authenticatedUser?.identityKey || req.ip || 'unknown';
    const now = Date.now();
    const current = attempts.get(key);
    const entry = current && now - current.startedAt < windowMs ? current : { startedAt: now, count: 0 };
    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > max) return errorResponse(res, 429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    return next();
  };
}

function validDate(value) { return typeof value === 'string' && DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function cleanText(value, max = 500) { return typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null; }
function amount(value) { const number = Number(value); return Number.isFinite(number) && number > 0 && number <= 100000000 ? number : null; }
function dateOr(value, fallback) { return validDate(value) ? value : fallback; }
function addDays(date, days) { const result = new Date(`${date}T00:00:00Z`); result.setUTCDate(result.getUTCDate() + Number(days || 0)); return result.toISOString().slice(0, 10); }

async function profileForRequest(req) {
  const profile = await findProfile(req.authenticatedUser);
  return profile;
}

async function ownedFarm(profileId, farmId) {
  if (!farmId) return null;
  const { data, error } = await supabase.from('farms').select('*').eq('id', farmId).eq('farmer_profile_id', profileId).maybeSingle();
  if (error) throw error;
  return data;
}

async function ownedCrop(profileId, cropId) {
  if (!cropId) return null;
  const { data, error } = await supabase.from('crops').select('*, farms!inner(farmer_profile_id)').eq('id', cropId).eq('farms.farmer_profile_id', profileId).maybeSingle();
  if (error) throw error;
  return data;
}

function normalizeAction(raw, currentDate) {
  if (!raw || typeof raw !== 'object' || !ACTION_TYPES.has(raw.type)) return null;
  const action = { type: raw.type };
  if (raw.cropId != null && !cleanText(raw.cropId, 100)) return null;
  if (raw.cropId) action.cropId = raw.cropId;
  if (raw.cropName != null) action.cropName = cleanText(raw.cropName, 100);
  if (raw.type === 'ADD_EXPENSE') {
    action.amount = amount(raw.amount);
    action.currency = raw.currency === 'INR' ? 'INR' : null;
    action.category = CATEGORIES.has(raw.category) ? raw.category : null;
    action.date = dateOr(raw.date, currentDate);
    action.description = cleanText(raw.description || 'Farm expense', 500);
    if (!action.amount || !action.currency || !action.category || !action.date || !action.description) return null;
  } else if (raw.type === 'SET_BUDGET') {
    action.amount = amount(raw.amount);
    action.period = ['total', 'season', 'crop'].includes(raw.period) ? raw.period : null;
    action.startDate = dateOr(raw.startDate, currentDate);
    action.endDate = raw.endDate == null ? null : dateOr(raw.endDate, null);
    if (!action.amount || !action.period || !action.startDate || (raw.endDate != null && !action.endDate)) return null;
  } else if (raw.type === 'ADD_CROP_UPDATE') {
    action.condition = cleanText(raw.condition, 500);
    action.growthStage = raw.growthStage == null ? null : cleanText(raw.growthStage, 100);
    action.pestObservation = raw.pestObservation == null ? null : cleanText(raw.pestObservation, 500);
    action.diseaseObservation = raw.diseaseObservation == null ? null : cleanText(raw.diseaseObservation, 500);
    action.notes = raw.notes == null ? null : cleanText(raw.notes, 1000);
    action.updateDate = dateOr(raw.updateDate, currentDate);
    if (!action.condition || !action.updateDate) return null;
  } else if (raw.type === 'ADD_CALENDAR_EVENT') {
    action.eventType = EVENT_TYPES.has(raw.eventType) ? raw.eventType : null;
    action.title = cleanText(raw.title, 200);
    action.description = raw.description == null ? null : cleanText(raw.description, 500);
    action.eventDate = dateOr(raw.eventDate, null);
    action.reminderDate = raw.reminderDate == null ? null : dateOr(raw.reminderDate, null);
    if (!action.eventType || !action.title || !action.eventDate || (raw.reminderDate != null && !action.reminderDate)) return null;
  }
  return action;
}

function groqPrompt(currentDate) {
  return `You are FarmVoice's farm diary parser. Understand informal mixed Telugu, Hindi, and English farmer speech. Today is ${currentDate}. Return only JSON matching the supplied schema. Use uppercase action types. Split every crop and every expense into its own action; never merge them. Calculate relative dates from today. Never invent a crop, amount, date, or activity. Missing required information must produce requiresClarification=true and a short question in the farmer's language. Expense categories are fertilizer, labor, irrigation, pesticide, seed, equipment, transport, other. Query actions identify intent only; the server calculates totals from Supabase. Do not output SQL, code, or extra keys.`;
}

const AI_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['requiresClarification', 'question', 'message', 'actions'],
  properties: {
    requiresClarification: { type: 'boolean' }, question: { type: ['string', 'null'] }, message: { type: 'string' },
    actions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'cropName', 'cropId', 'amount', 'currency', 'category', 'description', 'date', 'condition', 'growthStage', 'pestObservation', 'diseaseObservation', 'notes', 'updateDate', 'eventType', 'title', 'eventDate', 'reminderDate', 'period', 'startDate', 'endDate', 'relativeDays'], properties: {
      type: { type: 'string', enum: [...ACTION_TYPES] }, cropName: { type: ['string', 'null'] }, cropId: { type: ['string', 'null'] }, amount: { type: ['number', 'null'] }, currency: { type: ['string', 'null'] }, category: { type: ['string', 'null'] }, description: { type: ['string', 'null'] }, date: { type: ['string', 'null'] }, condition: { type: ['string', 'null'] }, growthStage: { type: ['string', 'null'] }, pestObservation: { type: ['string', 'null'] }, diseaseObservation: { type: ['string', 'null'] }, notes: { type: ['string', 'null'] }, updateDate: { type: ['string', 'null'] }, eventType: { type: ['string', 'null'] }, title: { type: ['string', 'null'] }, eventDate: { type: ['string', 'null'] }, reminderDate: { type: ['string', 'null'] }, period: { type: ['string', 'null'] }, startDate: { type: ['string', 'null'] }, endDate: { type: ['string', 'null'] }, relativeDays: { type: ['number', 'null'] },
    } } },
  },
};

async function parseVoice(text, language, currentDate) {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not configured');
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile', temperature: 0, response_format: { type: 'json_schema', json_schema: { name: 'farm_voice_command', strict: true, schema: AI_SCHEMA } }, messages: [{ role: 'system', content: groqPrompt(currentDate) }, { role: 'user', content: `Language hint: ${language}\nFarmer speech: ${text}` }] }) });
  if (!response.ok) throw new Error(`Groq request failed with status ${response.status}`);
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned no structured response');
  return JSON.parse(content);
}

async function saveAction(profile, action, body) {
  const crop = action.cropId ? await ownedCrop(profile.id, action.cropId) : null;
  if (action.cropId && !crop) return { error: ['INVALID_CROP', 'Crop does not belong to the authenticated farmer.'] };
  const farmId = body.farmId || crop?.farm_id;
  const farm = await ownedFarm(profile.id, farmId);
  if (!farm) return { error: ['UNAUTHORIZED', 'Farm ownership could not be verified.'] };
  let table; let values;
  if (action.type === 'ADD_EXPENSE') { table = 'expenses'; values = { farmer_profile_id: profile.id, farm_id: farm.id, crop_id: crop?.id || null, amount: action.amount, currency: action.currency, category: action.category, description: action.description, expense_date: action.date }; }
  else if (action.type === 'ADD_CROP_UPDATE') { if (!crop) return { error: ['INVALID_CROP', 'A crop is required for a crop update.'] }; table = 'crop_updates'; values = { farmer_profile_id: profile.id, farm_id: farm.id, crop_id: crop.id, condition: action.condition, growth_stage: action.growthStage, pest_observation: action.pestObservation, disease_observation: action.diseaseObservation, notes: action.notes, update_date: action.updateDate }; }
  else if (action.type === 'ADD_CALENDAR_EVENT') { table = 'calendar_events'; values = { farmer_profile_id: profile.id, farm_id: farm.id, crop_id: crop?.id || null, event_type: action.eventType, title: action.title, description: action.description, event_date: action.eventDate, reminder_date: action.reminderDate, completed: false }; }
  else if (action.type === 'SET_BUDGET') { table = 'budgets'; values = { farmer_profile_id: profile.id, farm_id: farm.id, crop_id: crop?.id || null, amount: action.amount, period: action.period, start_date: action.startDate, end_date: action.endDate }; }
  else return { error: ['UNSUPPORTED_ACTION', `Action ${action.type} is not writable.`] };
  const { data, error } = await supabase.from(table).insert(values).select('*').single();
  if (error) throw error;
  return { data };
}

async function expenseSummary(profileId, farmId, startDate, endDate) {
  let query = supabase.from('expenses').select('amount, category, crop_id, expense_date').eq('farmer_profile_id', profileId).eq('farm_id', farmId);
  if (startDate) query = query.gte('expense_date', startDate);
  if (endDate) query = query.lte('expense_date', endDate);
  const { data, error } = await query;
  if (error) throw error;
  const total = (data || []).reduce((sum, row) => sum + Number(row.amount), 0);
  return { totalSpent: total, count: data?.length || 0, expenses: data || [] };
}

function createFarmRouter() {
  const router = express.Router();
  router.use(requirePhoneEmailUser);
  router.post('/ai/voice-command', createRateLimiter(), async (req, res) => {
    try {
      const text = cleanText(req.body?.text, MAX_TEXT_LENGTH); const language = req.body?.language; const currentDate = req.body?.currentDate;
      if (!text) return errorResponse(res, 400, 'VALIDATION_ERROR', 'text is required and must be at most 4000 characters.');
      if (!LANGUAGES.has(language)) return errorResponse(res, 400, 'INVALID_LANGUAGE', 'language must be en, hi, or te.');
      if (!validDate(currentDate)) return errorResponse(res, 400, 'INVALID_DATE', 'currentDate must be YYYY-MM-DD.');
      const profile = await profileForRequest(req); if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Complete the farmer profile first.');
      const parsed = await parseVoice(text, language, currentDate);
      const actions = (parsed.actions || []).map((item) => normalizeAction({ ...item, eventDate: item.relativeDays != null ? addDays(currentDate, item.relativeDays) : item.eventDate }, currentDate));
      if (actions.some((item) => !item)) return errorResponse(res, 502, 'INVALID_AI_RESPONSE', 'The AI response did not match the farm action schema.');
      return res.json({ success: true, language, requiresConfirmation: !parsed.requiresClarification, requiresClarification: Boolean(parsed.requiresClarification), question: parsed.question || null, message: cleanText(parsed.message, 500) || 'Farm command understood.', actions });
    } catch (error) { console.error('Voice command failed:', error.message); return errorResponse(res, error.message.includes('Groq') ? 502 : 500, error.message.includes('Groq') ? 'GROQ_FAILURE' : 'SERVER_ERROR', 'The voice command could not be processed.'); }
  });
    router.post('/farm', async (req, res) => {
      try {
        const profile = await profileForRequest(req); const name = cleanText(req.body?.name, 100);
        if (!profile || !name) return errorResponse(res, 400, 'VALIDATION_ERROR', 'A farm name is required.');
        const timezone = cleanText(req.body?.timezone || 'Asia/Kolkata', 80);
        const { data, error } = await supabase.from('farms').insert({ farmer_profile_id: profile.id, name, timezone }).select('*').single();
        if (error) throw error;
        return res.status(201).json({ success: true, farm: data });
      } catch (error) { return errorResponse(res, 500, 'DATABASE_ERROR', 'Farm could not be created.'); }
    });
  router.post('/farm/actions/confirm', async (req, res) => {
    try { const profile = await profileForRequest(req); if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Complete the farmer profile first.'); const actions = req.body?.actions; if (!Array.isArray(actions) || !actions.length || actions.length > 50) return errorResponse(res, 400, 'VALIDATION_ERROR', 'actions must contain between 1 and 50 items.'); const results = []; for (const raw of actions) { const action = normalizeAction(raw, req.body.currentDate || new Date().toISOString().slice(0, 10)); if (!action) return errorResponse(res, 400, 'VALIDATION_ERROR', 'Every action must pass validation.'); const result = await saveAction(profile, action, req.body); if (result.error) return errorResponse(res, 403, result.error[0], result.error[1]); results.push(result.data); } return res.status(201).json({ success: true, records: results }); }
    catch (error) { console.error('Action confirmation failed:', error.message); return errorResponse(res, 500, 'DATABASE_ERROR', 'Confirmed farm actions could not be saved.'); }
  });
  router.post('/farm/crops', async (req, res) => { try { const profile = await profileForRequest(req); const farm = await ownedFarm(profile?.id, req.body?.farmId); const name = cleanText(req.body?.name, 100); if (!farm || !name) return errorResponse(res, 400, 'VALIDATION_ERROR', 'A valid owned farm and crop name are required.'); const { data, error } = await supabase.from('crops').insert({ farmer_profile_id: profile.id, farm_id: farm.id, name, variety: cleanText(req.body.variety, 100) }).select('*').single(); if (error) throw error; return res.status(201).json({ success: true, crop: data }); } catch (error) { return errorResponse(res, 500, 'DATABASE_ERROR', 'Crop could not be created.'); } });
  router.get('/farm/diary', async (req, res) => { try { const profile = await profileForRequest(req); const farm = await ownedFarm(profile?.id, req.query.farmId); if (!farm) return errorResponse(res, 403, 'UNAUTHORIZED', 'Farm ownership could not be verified.'); const today = req.query.date || new Date().toISOString().slice(0, 10); const [expenses, updates, events, crops, budgets] = await Promise.all([supabase.from('expenses').select('*').eq('farmer_profile_id', profile.id).eq('farm_id', farm.id).eq('expense_date', today), supabase.from('crop_updates').select('*').eq('farmer_profile_id', profile.id).eq('farm_id', farm.id).eq('update_date', today), supabase.from('calendar_events').select('*').eq('farmer_profile_id', profile.id).eq('farm_id', farm.id).gte('event_date', today).order('event_date').limit(50), supabase.from('crops').select('*').eq('farmer_profile_id', profile.id).eq('farm_id', farm.id).eq('active', true), supabase.from('budgets').select('*').eq('farmer_profile_id', profile.id).eq('farm_id', farm.id)]); if ([expenses, updates, events, crops, budgets].some((result) => result.error)) throw new Error('Dashboard query failed'); const totalSpent = (expenses.data || []).reduce((sum, row) => sum + Number(row.amount), 0); const totalBudget = (budgets.data || []).reduce((sum, row) => sum + Number(row.amount), 0); return res.json({ success: true, expenses: expenses.data || [], todayTotalSpending: totalSpent, cropUpdates: updates.data || [], upcomingCalendarEvents: events.data || [], activeCrops: crops.data || [], budget: { totalBudget, totalSpent, remainingBudget: totalBudget - totalSpent, spentPercentage: totalBudget ? (totalSpent / totalBudget) * 100 : 0, isExceeded: totalSpent > totalBudget } }); } catch (error) { return errorResponse(res, 500, 'DATABASE_ERROR', 'Farm diary could not be loaded.'); } });
  router.get('/farm/expenses/summary', async (req, res) => { try { const profile = await profileForRequest(req); const farm = await ownedFarm(profile?.id, req.query.farmId); if (!farm) return errorResponse(res, 403, 'UNAUTHORIZED', 'Farm ownership could not be verified.'); return res.json({ success: true, ...(await expenseSummary(profile.id, farm.id, req.query.startDate, req.query.endDate)) }); } catch (error) { return errorResponse(res, 500, 'DATABASE_ERROR', 'Expense summary could not be loaded.'); } });
  return router;
}

module.exports = { createFarmRouter };