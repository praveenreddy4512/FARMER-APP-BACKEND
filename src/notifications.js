const crypto = require('crypto');
const express = require('express');
const { getApps, initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { supabase } = require('./supabase');
const { findProfile, requirePhoneEmailUser } = require('./auth');

const NOTIFICATION_TYPES = new Set(['weather', 'price', 'farming', 'general', 'daily']);
const PREFERENCE_KEYS = {
  weather: 'weather',
  price: 'price',
  farming: 'farming',
  daily: 'daily',
  general: 'enabled',
};
const ADMIN_SESSION_DURATION_SECONDS = 8 * 60 * 60;

function errorResponse(res, status, code, message) {
  return res.status(status).json({ success: false, error: { code, message } });
}

function text(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max
    ? value.trim()
    : null;
}

function notificationType(value) {
  return NOTIFICATION_TYPES.has(value) ? value : 'general';
}

function adminToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    expiresAt: Math.floor(Date.now() / 1000) + ADMIN_SESSION_DURATION_SECONDS,
  })).toString('base64url');
  const signature = crypto
    .createHmac('sha256', process.env.ADMIN_SESSION_SECRET || '')
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

function validAdminToken(token) {
  if (!token || !process.env.ADMIN_SESSION_SECRET) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.ADMIN_SESSION_SECRET)
    .update(payload)
    .digest('base64url');
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.username === process.env.ADMIN_USERNAME &&
      Number(claims.expiresAt) > Math.floor(Date.now() / 1000);
  } catch (_) {
    return false;
  }
}

function preferencesForDevice(device) {
  return device.preferences && typeof device.preferences === 'object'
    ? device.preferences
    : {};
}

function isAllowed(device, type) {
  const preferences = preferencesForDevice(device);
  if (preferences.enabled === false || device.enabled === false) return false;
  return preferences[PREFERENCE_KEYS[type]] !== false;
}

function firebaseMessaging() {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return null;
  if (!getApps().length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getMessaging();
}

async function findDevices(profileIds) {
  let query = supabase.from('notification_devices').select('*').eq('enabled', true);
  if (profileIds?.length) query = query.in('farmer_profile_id', profileIds);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function hasDedupe(profileId, dedupeKey) {
  if (!dedupeKey) return false;
  const { data, error } = await supabase
    .from('notifications')
    .select('id')
    .eq('farmer_profile_id', profileId)
    .eq('dedupe_key', dedupeKey)
    .limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function insertNotification({ profileId, title, body, type, data, source, dedupeKey }) {
  const { data: row, error } = await supabase
    .from('notifications')
    .insert({
      farmer_profile_id: profileId || null,
      title,
      body,
      type,
      data: data || {},
      source: source || 'system',
      dedupe_key: dedupeKey || null,
    })
    .select('*')
    .single();
  if (error) throw error;
  return row;
}

async function logDelivery(notificationId, device, status, error) {
  await supabase.from('notification_deliveries').insert({
    notification_id: notificationId,
    device_id: device?.id || null,
    token: device?.token || '',
    status,
    error_code: error?.code || null,
    error_message: error?.message || null,
  });
}

async function deliverNotification(notification, devices) {
  if (!devices.length) return { sent: 0, failed: 0 };
  const messaging = firebaseMessaging();
  if (!messaging) {
    for (const device of devices) await logDelivery(notification.id, device, 'not_configured');
    return { sent: 0, failed: devices.length };
  }

  let sent = 0;
  let failed = 0;
  for (let start = 0; start < devices.length; start += 500) {
    const chunk = devices.slice(start, start + 500);
    const message = {
      tokens: chunk.map((device) => device.token),
      notification: { title: notification.title, body: notification.body },
      data: Object.fromEntries(Object.entries({
        notificationId: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        ...(notification.data || {}),
      }).map(([key, value]) => [key, String(value)])),
      android: { priority: 'high', notification: { channelId: 'farmvoice_channel' } },
    };
    const response = await messaging.sendEachForMulticast(message);
    for (let index = 0; index < chunk.length; index += 1) {
      const result = response.responses[index];
      if (result.success) {
        sent += 1;
        await logDelivery(notification.id, chunk[index], 'sent');
      } else {
        failed += 1;
        await logDelivery(notification.id, chunk[index], 'failed', result.error);
        if (result.error?.code === 'messaging/registration-token-not-registered') {
          await supabase.from('notification_devices').update({ enabled: false }).eq('id', chunk[index].id);
        }
      }
    }
  }
  return { sent, failed };
}

async function sendToAudience({ title, body, type = 'general', data = {}, source = 'system', profileIds, dedupeKey }) {
  const normalizedType = notificationType(type);
  const devices = (await findDevices(profileIds)).filter((device) => isAllowed(device, normalizedType));
  const groups = new Map();
  for (const device of devices) {
    const key = profileIds?.length ? device.farmer_profile_id : 'broadcast';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(device);
  }

  let sent = 0;
  let failed = 0;
  let created = 0;
  for (const [profileId, group] of groups) {
    const scopedDedupe = dedupeKey && profileId !== 'broadcast'
      ? `${dedupeKey}:${profileId}`
      : dedupeKey;
    if (await hasDedupe(profileId === 'broadcast' ? null : profileId, scopedDedupe)) continue;
    const notification = await insertNotification({
      profileId: profileId === 'broadcast' ? null : profileId,
      title,
      body,
      type: normalizedType,
      data,
      source,
      dedupeKey: scopedDedupe,
    });
    const result = await deliverNotification(notification, group);
    sent += result.sent;
    failed += result.failed;
    created += 1;
  }
  return { created, sent, failed, recipients: groups.size };
}

async function registerDevice(req, res) {
  try {
    const profile = await findProfile(req.authenticatedUser);
    if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Complete the farmer profile first.');
    const token = text(req.body?.token, 4096);
    if (!token) return errorResponse(res, 400, 'INVALID_TOKEN', 'A Firebase registration token is required.');
    const preferences = req.body?.preferences && typeof req.body.preferences === 'object' ? req.body.preferences : {};
    const selectedCrops = Array.isArray(req.body?.selectedCrops) ? req.body.selectedCrops.slice(0, 20).map(String) : [];
    const values = {
      farmer_profile_id: profile.id,
      token,
      platform: text(req.body?.platform, 20) || 'android',
      language: text(req.body?.language, 10) || profile.preferred_language || 'en',
      latitude: Number.isFinite(Number(req.body?.latitude)) ? Number(req.body.latitude) : null,
      longitude: Number.isFinite(Number(req.body?.longitude)) ? Number(req.body.longitude) : null,
      selected_crops: selectedCrops,
      preferences,
      enabled: true,
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await supabase
      .from('notification_devices')
      .upsert(values, { onConflict: 'token' })
      .select('id, token, platform, enabled, last_seen_at')
      .single();
    if (error) throw error;
    return res.json({ success: true, device: data });
  } catch (error) {
    console.error('Notification device registration failed:', error.message);
    return errorResponse(res, 500, 'DATABASE_ERROR', 'The notification device could not be registered.');
  }
}

function createNotificationRouter() {
  const router = express.Router();
  router.use(requirePhoneEmailUser);

  router.post('/devices', registerDevice);
  router.delete('/devices', async (req, res) => {
    const token = text(req.body?.token, 4096);
    if (!token) return errorResponse(res, 400, 'INVALID_TOKEN', 'A Firebase registration token is required.');
    await supabase.from('notification_devices').update({ enabled: false }).eq('token', token);
    return res.json({ success: true });
  });

  router.get('/', async (req, res) => {
    try {
      const profile = await findProfile(req.authenticatedUser);
      if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Complete the farmer profile first.');
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const { data, error } = await supabase
        .from('notifications')
        .select('*')
        .or(`farmer_profile_id.eq.${profile.id},farmer_profile_id.is.null`)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      const ids = (data || []).map((row) => row.id);
      const { data: reads } = ids.length
        ? await supabase.from('notification_reads').select('notification_id').eq('farmer_profile_id', profile.id).in('notification_id', ids)
        : { data: [] };
      const readIds = new Set((reads || []).map((row) => row.notification_id));
      return res.json({ success: true, notifications: (data || []).map((row) => ({ ...row, read: readIds.has(row.id) })) });
    } catch (error) {
      return errorResponse(res, 500, 'DATABASE_ERROR', 'Notifications could not be loaded.');
    }
  });

  router.post('/:id/read', async (req, res) => {
    try {
      const profile = await findProfile(req.authenticatedUser);
      const { data: notification } = await supabase.from('notifications').select('id').eq('id', req.params.id).or(`farmer_profile_id.eq.${profile?.id},farmer_profile_id.is.null`).maybeSingle();
      if (!notification) return errorResponse(res, 404, 'NOT_FOUND', 'Notification was not found.');
      const { error } = await supabase.from('notification_reads').upsert({ notification_id: notification.id, farmer_profile_id: profile.id }, { onConflict: 'notification_id,farmer_profile_id' });
      if (error) throw error;
      return res.json({ success: true });
    } catch (error) {
      return errorResponse(res, 500, 'DATABASE_ERROR', 'Notification could not be marked as read.');
    }
  });

  return router;
}

function requireAdmin(req, res, next) {
  const match = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!validAdminToken(match?.[1])) return errorResponse(res, 401, 'ADMIN_AUTHENTICATION_REQUIRED', 'A valid admin login is required.');
  return next();
}

function createAdminAuthRouter() {
  const router = express.Router();
  const attempts = new Map();
  router.post('/login', (req, res) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const current = attempts.get(key);
    if (current && now - current.startedAt < 60_000 && current.count >= 5) {
      return errorResponse(res, 429, 'RATE_LIMITED', 'Too many login attempts. Try again later.');
    }
    const entry = current && now - current.startedAt < 60_000
      ? current
      : { startedAt: now, count: 0 };
    entry.count += 1;
    attempts.set(key, entry);

    const username = text(req.body?.username, 100);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD ||
        username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
      return errorResponse(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin username or password.');
    }
    attempts.delete(key);
    return res.json({
      success: true,
      token: adminToken(username),
      expiresIn: ADMIN_SESSION_DURATION_SECONDS,
    });
  });
  return router;
}

function createAdminNotificationRouter() {
  const router = express.Router();
  router.use(requireAdmin);
  router.post('/send', async (req, res) => {
    try {
      const title = text(req.body?.title, 120);
      const body = text(req.body?.body, 1000);
      const type = notificationType(req.body?.type);
      const profileIds = Array.isArray(req.body?.profileIds) ? req.body.profileIds.slice(0, 500) : undefined;
      if (!title || !body) return errorResponse(res, 400, 'VALIDATION_ERROR', 'title and body are required.');
      const result = await sendToAudience({ title, body, type, data: req.body?.data || {}, source: 'admin', profileIds, dedupeKey: text(req.body?.dedupeKey, 200) });
      return res.json({ success: true, ...result });
    } catch (error) {
      console.error('Admin notification send failed:', error.message);
      return errorResponse(res, 500, 'SEND_FAILED', 'The notification could not be sent.');
    }
  });
  return router;
}

async function fetchWeatherAlert(device) {
  if (device.latitude == null || device.longitude == null) return null;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${device.latitude}&longitude=${device.longitude}&daily=temperature_2m_max,precipitation_probability_max&forecast_days=1&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) return null;
  const weather = await response.json();
  const maxTemp = Number(weather.daily?.temperature_2m_max?.[0] || 0);
  const rainChance = Number(weather.daily?.precipitation_probability_max?.[0] || 0);
  if (rainChance >= 70) return { title: 'Rain expected today', body: `Rain chance is ${rainChance}%. Plan field work and protect harvested crops.` };
  if (maxTemp >= 38) return { title: 'High heat alert', body: `Today may reach ${Math.round(maxTemp)}°C. Water crops early and protect livestock.` };
  return null;
}

async function runAutomaticNotifications({ pricesRefreshed = false } = {}) {
  const devices = await findDevices();
  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const device of devices) {
    const profileId = device.farmer_profile_id;
    if (isAllowed(device, 'daily')) results.push(await sendToAudience({ profileIds: [profileId], type: 'daily', source: 'system', dedupeKey: `daily:${today}`, title: 'Your FarmVoice daily briefing', body: 'Open FarmVoice for today’s weather, market prices, and farm reminders.' }));
    if (pricesRefreshed && isAllowed(device, 'price')) results.push(await sendToAudience({ profileIds: [profileId], type: 'price', source: 'system', dedupeKey: `prices:${today}`, title: 'Market prices updated', body: 'Latest mandi prices are available for your selected crops.' }));
    if (isAllowed(device, 'weather')) {
      try {
        const alert = await fetchWeatherAlert(device);
        if (alert) results.push(await sendToAudience({ profileIds: [profileId], type: 'weather', source: 'system', dedupeKey: `weather:${today}:${alert.title}`, title: alert.title, body: alert.body }));
      } catch (error) { console.error('Weather alert failed:', error.message); }
    }
  }
  const { data: reminders } = await supabase.from('calendar_events').select('id, farmer_profile_id, title').eq('completed', false).lte('reminder_date', today).limit(500);
  for (const reminder of reminders || []) {
    results.push(await sendToAudience({ profileIds: [reminder.farmer_profile_id], type: 'farming', source: 'system', dedupeKey: `reminder:${reminder.id}`, title: 'Farm reminder', body: reminder.title }));
  }
  return results;
}

module.exports = {
  createNotificationRouter,
  createAdminAuthRouter,
  createAdminNotificationRouter,
  runAutomaticNotifications,
  sendToAudience,
};
