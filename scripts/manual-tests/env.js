// Shared configuration for the manual test scripts.
//
// Everything is read from the environment — never hardcode credentials here,
// these files are committed.

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(
      `Missing ${name}.\n` +
      `These scripts run against a live stack. Source the environment first, e.g.\n` +
      `  set -a; . /opt/echo/EchoOrchestrator/.env; set +a\n`
    );
    process.exit(2);
  }
  return v;
}

module.exports = {
  BASE: process.env.ECHO_BASE_URL || 'http://127.0.0.1:3160',
  db: () => ({
    host: process.env.DB_HOST_LOCAL || '127.0.0.1',
    port: Number(process.env.DB_PORT_LOCAL || 13306),
    user: process.env.MYSQL_USER || 'echo_app',
    password: required('MYSQL_PASSWORD'),
    database: process.env.MYSQL_DATABASE || 'echo_db',
  }),
  ssoSecret: () => required('UISP_SSO_SECRET'),
  crmKey: () => required('UISP_CRM_APP_KEY_READ'),
  crmBase: () => required('UISP_BASE_URL') + '/crm/api/v1.0',
  mysql: require('../../node_modules/mysql2/promise'),
};
