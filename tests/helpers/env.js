function getNzConfig(overrides = {}) {
  const host = process.env.NZ_DEV_HOST;
  const password = process.env.NZ_DEV_PASSWORD;
  if (!host || !password) {
    // Allow lab defaults only when NZ_USE_LAB_DEFAULTS=1
    if (process.env.NZ_USE_LAB_DEFAULTS === '1') {
      return {
        host: host || '192.168.0.144',
        port: parseInt(process.env.NZ_DEV_PORT || '5480', 10),
        database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
        user: process.env.NZ_DEV_USER || 'admin',
        password: password || 'password',
        ...overrides,
      };
    }
    throw new Error(
      'Set NZ_DEV_HOST and NZ_DEV_PASSWORD (or NZ_USE_LAB_DEFAULTS=1 for local lab defaults)'
    );
  }
  return {
    host,
    port: parseInt(process.env.NZ_DEV_PORT || '5480', 10),
    database: process.env.NZ_DEV_DATABASE || 'JUST_DATA',
    user: process.env.NZ_DEV_USER || 'admin',
    password,
    ...overrides,
  };
}

module.exports = { getNzConfig };
