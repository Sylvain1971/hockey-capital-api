try {
  require('../src/server');
  console.log('LOAD_OK');
} catch(e) {
  console.log('CRASH:', e.message);
  console.log(e.stack);
}
