// Redis（Upstash）の接続情報を、どの環境変数から読むかを決める。
// import を一切持たないのは、/api/health が設定不備の状況でも使えるようにするため。
//
// 上にあるものほど優先される。URL とトークンが「両方」そろった最初の組を採用する。
//
//  1. CIRCLE_REDIS_REST_*  … このアプリ専用の指定。Vercel のストレージ連携に依存しない。
//                           連携のストアが削除・差し替えされた時や、変数名に接頭辞が付いて
//                           下の名前で読めなくなった時は、これを設定して接続先を固定する。
//  2. UPSTASH_REDIS_REST_* … Upstash 公式の名前
//  3. KV_REST_API_*        … Vercel のストレージ連携が自動で入れる名前
export const REDIS_ENV_PAIRS = [
  ['CIRCLE_REDIS_REST_URL', 'CIRCLE_REDIS_REST_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
];

// .env 形式の表示（KEY="値"）からコピーすると引用符ごと貼られやすいので、外側の引用符は外す
const clean = (v) => String(v || '').trim().replace(/^(["'])(.*)\1$/, '$2').trim();

export function redisEnv(env = process.env) {
  for (const [urlName, tokenName] of REDIS_ENV_PAIRS) {
    const url = clean(env[urlName]);
    const token = clean(env[tokenName]);
    if (url && token) return { url, token, source: `${urlName} / ${tokenName}` };
  }
  return null;
}
