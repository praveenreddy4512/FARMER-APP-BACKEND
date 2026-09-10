const express = require('express');
const { supabase } = require('./supabase');

const PHONE_EMAIL_GET_USER_URL = 'https://eapi.phone.email/getuser';
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const MAX_NAME_LENGTH = 100;

function errorResponse(res, status, code, message) {
  return res.status(status).json({
    success: false,
    error: { code, message },
  });
}

function normalizeName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) {
    return null;
  }
  return name;
}

function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const language = value.trim();
  return LANGUAGE_PATTERN.test(language) ? language : null;
}

function maskPhone(phone) {
  if (!phone) return '';
  return `${'*'.repeat(Math.max(0, phone.length - 4))}${phone.slice(-4)}`;
}

function identityFromPhoneEmail(data) {
  const phoneNumber = String(data.phone_no || data.user_phone_number || '').trim();
  const countryCode = String(data.country_code || data.user_country_code || '').trim();
  const phoneEmailUserId = data.user_id || data.userId || data.phone_email_user_id || null;

  if (!phoneNumber || !countryCode || data.status !== 200) return null;

  return {
    phoneNumber,
    countryCode,
    phoneEmailUserId: phoneEmailUserId ? String(phoneEmailUserId) : null,
    identityKey: phoneEmailUserId
      ? `phone-email:${phoneEmailUserId}`
      : `phone:${countryCode}:${phoneNumber}`,
  };
}

async function verifyPhoneEmailAccessToken(accessToken) {
  if (!process.env.PHONE_EMAIL_CLIENT_ID) {
    throw new Error('PHONE_EMAIL_CLIENT_ID is not configured');
  }

  const response = await fetch(PHONE_EMAIL_GET_USER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      access_token: accessToken,
      client_id: process.env.PHONE_EMAIL_CLIENT_ID,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  return identityFromPhoneEmail(data);
}

async function requirePhoneEmailUser(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return errorResponse(res, 401, 'AUTHENTICATION_REQUIRED', 'A Phone.Email access token is required.');
  }

  try {
    const identity = await verifyPhoneEmailAccessToken(match[1]);
    if (!identity) {
      return errorResponse(res, 401, 'AUTHENTICATION_FAILED', 'Phone authentication could not be verified.');
    }
    req.authenticatedUser = identity;
    return next();
  } catch (error) {
    console.error('Phone.Email verification failed:', error.message);
    return errorResponse(res, 503, 'AUTHENTICATION_PROVIDER_UNAVAILABLE', 'Phone authentication is temporarily unavailable.');
  }
}

function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const attempts = new Map();

  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const current = attempts.get(key);
    const entry = current && now - current.startedAt < windowMs
      ? current
      : { startedAt: now, count: 0 };

    entry.count += 1;
    attempts.set(key, entry);
    if (entry.count > max) {
      return errorResponse(res, 429, 'RATE_LIMITED', 'Too many profile requests. Please try again later.');
    }
    return next();
  };
}

function profilePayload(profile) {
  const profileCompleted = Boolean(profile.full_name);
  return {
    id: profile.id,
    fullName: profile.full_name,
    phoneNumber: maskPhone(profile.phone_number),
    preferredLanguage: profile.preferred_language,
    phoneVerified: profile.phone_verified,
    onboardingCompleted: profile.onboarding_completed,
    profileCompleted,
    ...(profileCompleted ? {} : { missingFields: ['fullName'] }),
  };
}

function userResponse(res, profile, status = 200) {
  return res.status(status).json({
    success: true,
    user: profilePayload(profile),
    profileCompleted: Boolean(profile.full_name),
    onboardingCompleted: profile.onboarding_completed,
    ...(profile.full_name ? {} : { missingFields: ['fullName'] }),
  });
}

async function findProfile(identity) {
  if (identity.phoneEmailUserId) {
    const { data, error } = await supabase
      .from('farmer_profiles')
      .select('*')
      .eq('phone_email_user_id', identity.phoneEmailUserId)
      .maybeSingle();
    if (error) throw error;
    if (data) return data;
  }

  const { data, error } = await supabase
    .from('farmer_profiles')
    .select('*')
    .eq('phone_number', identity.phoneNumber)
    .eq('country_code', identity.countryCode)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function createAuthRouter() {
  const router = express.Router();
  const profileRateLimit = createRateLimiter();
  router.use(requirePhoneEmailUser);
  router.use(profileRateLimit);

  router.post('/profile', async (req, res) => {
    try {
      const fullName = normalizeName(req.body?.fullName);
      const preferredLanguage = normalizeLanguage(req.body?.preferredLanguage);
      if (!fullName) return errorResponse(res, 400, 'INVALID_NAME', 'A valid full name is required.');
      if (!preferredLanguage) return errorResponse(res, 400, 'INVALID_LANGUAGE', 'Preferred language must be a valid language code.');

      const existing = await findProfile(req.authenticatedUser);
      const now = new Date().toISOString();
      const values = {
        ...(existing ? { id: existing.id } : {}),
        phone_number: req.authenticatedUser.phoneNumber,
        country_code: req.authenticatedUser.countryCode,
        full_name: fullName,
        preferred_language: preferredLanguage,
        phone_verified: true,
        phone_email_user_id: req.authenticatedUser.phoneEmailUserId,
        updated_at: now,
        last_login_at: now,
        ...(existing ? {} : { created_at: now }),
        profile_completed_at: existing?.profile_completed_at || now,
        onboarding_completed: true,
      };

      const profileQuery = existing
        ? supabase.from('farmer_profiles').update(values).eq('id', existing.id)
        : supabase.from('farmer_profiles').insert(values);
      const { data, error } = await profileQuery.select('*').single();
      if (error) throw error;
      return userResponse(res, data, existing ? 200 : 201);
    } catch (error) {
      console.error('Profile creation failed:', error.message);
      return errorResponse(res, 500, 'DATABASE_ERROR', 'The farmer profile could not be saved.');
    }
  });

  router.get('/me', async (req, res) => {
    try {
      const profile = await findProfile(req.authenticatedUser);
      if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Farmer profile was not found.');
      await supabase.from('farmer_profiles').update({ last_login_at: new Date().toISOString() }).eq('id', profile.id);
      return userResponse(res, profile);
    } catch (error) {
      console.error('Profile lookup failed:', error.message);
      return errorResponse(res, 500, 'DATABASE_ERROR', 'The farmer profile could not be loaded.');
    }
  });

  router.patch('/profile', async (req, res) => {
    try {
      const updates = {};
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'fullName')) {
        updates.full_name = normalizeName(req.body.fullName);
        if (!updates.full_name) return errorResponse(res, 400, 'INVALID_NAME', 'A valid full name is required.');
      }
      if (Object.prototype.hasOwnProperty.call(req.body || {}, 'preferredLanguage')) {
        updates.preferred_language = normalizeLanguage(req.body.preferredLanguage);
        if (!updates.preferred_language) return errorResponse(res, 400, 'INVALID_LANGUAGE', 'Preferred language must be a valid language code.');
      }
      if (!Object.keys(updates).length) return errorResponse(res, 400, 'NO_UPDATABLE_FIELDS', 'Provide fullName or preferredLanguage.');

      const profile = await findProfile(req.authenticatedUser);
      if (!profile) return errorResponse(res, 404, 'PROFILE_NOT_FOUND', 'Farmer profile was not found.');
      updates.updated_at = new Date().toISOString();
      if (updates.full_name && !profile.profile_completed_at) updates.profile_completed_at = updates.updated_at;
      if (updates.full_name) updates.onboarding_completed = true;

      const { data, error } = await supabase.from('farmer_profiles').update(updates).eq('id', profile.id).select('*').single();
      if (error) throw error;
      return userResponse(res, data);
    } catch (error) {
      console.error('Profile update failed:', error.message);
      return errorResponse(res, 500, 'DATABASE_ERROR', 'The farmer profile could not be updated.');
    }
  });

  return router;
}

module.exports = {
  createAuthRouter,
  requirePhoneEmailUser,
  findProfile,
  verifyPhoneEmailAccessToken,
  profilePayload,
  identityFromPhoneEmail,
};