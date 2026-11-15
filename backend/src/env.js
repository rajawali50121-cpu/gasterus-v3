import { readFileSync } from 'node:fs';

function raw(name, fallback = '') {
  const file = String(process.env[`${name}_FILE`] ?? '').trim();
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new Error(`Unable to read secret file for ${name}`);
    }
  }
  return String(process.env[name] ?? fallback).trim();
}

export function requiredSecret(name, min = 1) {
  const value = raw(name);
  if (value.length < min) throw new Error(`${name} is required and must contain at least ${min} characters`);
  return value;
}

export function optionalSecret(name, fallback = '') {
  return raw(name, fallback);
}

export function text(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

export function int(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function boundedInt(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  const bounded = Math.max(min, Math.min(max, value));
  if (bounded !== value) {
    console.warn(`${name} is outside the supported range; using ${bounded}`);
  }
  return bounded;
}

export function naturalInt(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${min}`);
  }
  return value;
}

// Like int() but with no upper bound: used for pagination/event caps that must
// not silently truncate the API catalog. Zero means "no cap".
export function unboundedInt(name, fallback, min = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) {
    throw new Error(`${name} must be a safe integer greater than or equal to ${min}`);
  }
  return value;
}

export function bool(name, fallback = false) {
  const value = String(process.env[name] ?? fallback).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}
