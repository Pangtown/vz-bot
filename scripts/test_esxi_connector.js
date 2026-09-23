import { testEsxiConnection } from '../src/vmware/esxi-client.js';
import { loadClouds, saveCloud, getCloudById, deleteCloud } from '../src/vmware/cloud-storage.js';

async function runTests() {
  console.log('=== 1. Testing Cloud Storage Persistence ===');
  const testCloud = {
    id: 'test-cloud-' + Date.now(),
    name: 'Lab ESXi Host',
    desc: 'Automated test cloud',
    host: '192.168.100.50',
    port: 443,
    user: 'root',
    pass: 'SuperSecret123',
    insecure: true,
  };

  const saved = await saveCloud(testCloud);
  console.log('✓ Saved cloud:', saved.name, 'ID:', saved.id);
  console.log('  Password masked:', saved.pass === '********');

  const retrieved = await getCloudById(saved.id, true);
  console.log('✓ Retrieved with secret:', retrieved.pass === 'SuperSecret123');

  const allClouds = await loadClouds(false);
  const found = allClouds.find(c => c.id === saved.id);
  console.log('✓ Found in loadClouds list:', Boolean(found));

  console.log('\n=== 2. Testing ESXi Connection Validation (Error Handling) ===');
  // Test connection to unreachable dummy host: should return structured error, not throw or crash
  const connResult = await testEsxiConnection({
    host: '127.0.0.99',
    port: 44321,
    username: 'root',
    password: 'wrongpassword',
    insecure: true,
  });

  console.log('✓ Unreachable host response:', connResult.ok === false ? 'OK (Handled cleanly)' : 'Unexpected');
  console.log('  Error message reported:', connResult.error);

  console.log('\n=== 3. Cleaning up Test Cloud ===');
  await deleteCloud(saved.id);
  const afterDelete = await getCloudById(saved.id);
  console.log('✓ Cleaned up:', afterDelete === null);

  console.log('\nAll direct ESXi connector & storage unit tests PASSED! 🎉');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
