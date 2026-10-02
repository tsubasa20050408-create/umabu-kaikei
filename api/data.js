import { getRedis, verifyToken } from './_lib.js';
import { createDataHandler } from './_data-handler.js';
export default createDataHandler({ getRedis, verifyToken });
