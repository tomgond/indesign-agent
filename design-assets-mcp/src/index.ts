import { startDesignAssetsServer } from './server.js';

startDesignAssetsServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
