import { getRedis, verifyToken } from './_lib.js';
import { createAuditHandler } from './_audit-handler.js';
export default createAuditHandler({ getRedis, verifyToken });
