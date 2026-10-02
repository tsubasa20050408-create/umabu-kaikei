import { getRedis, verifyToken } from './_lib.js';
import { createReceiptHandler } from './_receipt-handler.js';
export default createReceiptHandler({ getRedis, verifyToken });
