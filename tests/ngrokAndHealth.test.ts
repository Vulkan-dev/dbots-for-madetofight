import { loadConfig } from '../src/config';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running config tests...\n');

  const origWebPort = process.env.WEB_PORT;
  const origNgrokDomain = process.env.NGROK_DOMAIN;
  const origPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  try {
    // 1. Test Port Fallback: WEB_PORT
    process.env.WEB_PORT = '3555';
    delete process.env.NGROK_DOMAIN;
    delete process.env.PUBLIC_BASE_URL;
    const config1 = loadConfig();
    assert(config1.webServer.port === 3555, `Expected port 3555 from WEB_PORT, got ${config1.webServer.port}`);
    console.log('✔ WEB_PORT fallback test passed.');

    // 2. Test frontendUrl defaults to * when not set
    const config2 = loadConfig();
    assert(config2.webServer.frontendUrl === '*', `Expected '*', got ${config2.webServer.frontendUrl}`);
    console.log('✔ frontendUrl default test passed.');

    console.log('\nAll config tests passed successfully!\n');
  } finally {
    if (origWebPort !== undefined) process.env.WEB_PORT = origWebPort; else delete process.env.WEB_PORT;
    if (origNgrokDomain !== undefined) process.env.NGROK_DOMAIN = origNgrokDomain; else delete process.env.NGROK_DOMAIN;
    if (origPublicBaseUrl !== undefined) process.env.PUBLIC_BASE_URL = origPublicBaseUrl; else delete process.env.PUBLIC_BASE_URL;
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
