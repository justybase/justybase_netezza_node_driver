function getNzConfig(overrides = {}) {
  const host = process.env.NZ_DEV_HOST;
  const password = process.env.NZ_DEV_PASSWORD;
  const allowLabDefaults =
    process.env.NZ_DEV_ALLOW_LAB_DEFAULTS === '1' || process.env.NZ_USE_LAB_DEFAULTS === '1';
  if (!host || !password) {
    // Allow lab defaults only when explicitly requested.
    if (allowLabDefaults) {
      return {
        host: host || '127.0.0.1',
        port: parseInt(process.env.NZ_DEV_PORT || '5480', 10),
        database: process.env.NZ_DEV_DATABASE || process.env.NZ_DEV_DB || 'JUST_DATA',
        user: process.env.NZ_DEV_USER || 'admin',
        password: password || 'password',
        ...overrides,
      };
    }
    throw new Error(
      'Set NZ_DEV_HOST and NZ_DEV_PASSWORD (or NZ_DEV_ALLOW_LAB_DEFAULTS=1 for local lab defaults)'
    );
  }
  return {
    host,
    port: parseInt(process.env.NZ_DEV_PORT || '5480', 10),
    database: process.env.NZ_DEV_DATABASE || process.env.NZ_DEV_DB || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password,
    ...overrides,
  };
}

module.exports = { getNzConfig };
