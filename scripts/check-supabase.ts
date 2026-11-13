import pg from "pg";
import { createClient } from "@supabase/supabase-js";

// Read-only diagnostics. Never log exception messages, URLs, tokens or row data.
type Probe = { ok: boolean; code?: string; status?: number; description: string; details?: Record<string, boolean | string | number> };
const results: Record<string, Probe> = {};
function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(code) ? code : "REQUEST_FAILED";
}
function failed(name: string, error: unknown, description: string) {
  const status = Number((error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode);
  results[name] = { ok: false, code: safeCode(error), ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}), description };
}

try { process.loadEnvFile(".env.local"); }
catch (error) {
  console.log(JSON.stringify({ environment: { loaded: false, code: safeCode(error) } }));
  process.exit(1);
}

const names = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET", "DATABASE_URL"] as const;
const presence = Object.fromEntries(names.map(name => [name, Boolean(process.env[name]?.trim())]));
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
const service = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
const databaseUrl = process.env.DATABASE_URL?.trim();
const consistency: Record<string, boolean | string> = {};
consistency.configuredBucketMatchesMigrationDefault = (process.env.SUPABASE_STORAGE_BUCKET || 'grammar-loop') === 'grammar-loop';
try {
  const api = new URL(url!);
  const db = new URL(databaseUrl!);
  consistency.projectUrlHasSupabaseApiHost = /^[a-z0-9-]+\.supabase\.co$/.test(api.hostname);
  consistency.urlPathIsRoot = api.pathname === '/' || api.pathname === '';
  consistency.databaseNameIsPostgres = decodeURIComponent(db.pathname) === '/postgres';
  const apiRef = api.hostname.endsWith('.supabase.co') ? api.hostname.split('.')[0] : undefined;
  const dbRef = db.hostname.startsWith('db.') ? db.hostname.split('.')[1] : decodeURIComponent(db.username).split('.')[1];
  consistency.projectReferencesComparable = Boolean(apiRef && dbRef);
  if (apiRef && dbRef) consistency.databaseProjectMatchesApiProject = apiRef === dbRef;
} catch { consistency.projectReferencesComparable = false; }
try {
  const payload = JSON.parse(Buffer.from(anon!.split('.')[1], 'base64url').toString());
  consistency.anonCredentialHasAnonRoleClaim = payload.role === 'anon';
  const apiRef = new URL(url!).hostname.split('.')[0];
  consistency.anonCredentialProjectMatchesApiProject = payload.ref === apiRef;
} catch { consistency.anonCredentialKind = anon?.startsWith('sb_publishable_') ? 'publishable' : 'other'; }
try {
  const payload = JSON.parse(Buffer.from(service!.split('.')[1], 'base64url').toString());
  consistency.serviceCredentialHasServiceRoleClaim = payload.role === 'service_role';
  consistency.serviceCredentialProjectMatchesApiProject = payload.ref === new URL(url!).hostname.split('.')[0];
} catch {
  consistency.serviceCredentialKind = service?.startsWith('sb_secret_') ? 'secret' : service?.startsWith('sb_publishable_') ? 'publishable' : 'other';
}
let validUrl = false;
try { validUrl = Boolean(url && new URL(url).protocol === "https:"); } catch {}

if (validUrl && url && anon) {
  try {
    const response = await fetch(new URL("/auth/v1/health", url), { headers: { apikey: anon }, signal: AbortSignal.timeout(12_000) });
    const contentIsJson = Boolean(response.headers.get('content-type')?.includes('application/json'));
    const payload = contentIsJson ? await response.json().catch(() => null) : null;
    const expectedHealthShape = Boolean(payload && typeof payload === 'object' && typeof payload.name === 'string' && payload.name.toLowerCase().includes('gotrue') && typeof payload.version === 'string');
    results.authHealth = { ok: response.ok && contentIsJson && expectedHealthShape, status: response.status, description: "Auth health reachability only; this endpoint alone does not verify the anonymous key.", details: { contentIsJson, expectedHealthShape } };
    const settingsResponse = await fetch(new URL('/auth/v1/settings', url), { headers: { apikey: anon }, signal: AbortSignal.timeout(12_000) });
    const settingsContentIsJson = Boolean(settingsResponse.headers.get('content-type')?.includes('application/json'));
    const settings = settingsContentIsJson ? await settingsResponse.json().catch(() => null) : null;
    const settingsShapeValid = Boolean(settings && typeof settings.external === 'object' && typeof settings.disable_signup === 'boolean');
    results.anonSettings = { ok: settingsResponse.ok && settingsContentIsJson && settingsShapeValid, status: settingsResponse.status, description: 'Anonymous-key Auth settings endpoint checked without printing configuration.', details: { contentIsJson: settingsContentIsJson, expectedSettingsShape: settingsShapeValid } };
    const anonymousClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }) } });
    const anonymousRead = await anonymousClient.from('gl_workspaces').select('user_id').limit(0);
    const explicitlyDenied = anonymousRead.status === 401 || anonymousRead.status === 403 || anonymousRead.error?.code === '42501';
    results.anonymousWorkspaceReadDenied = { ok: explicitlyDenied, status: anonymousRead.status, ...(anonymousRead.error ? { code: safeCode(anonymousRead.error) } : {}), description: explicitlyDenied ? 'Anonymous access to business state is denied.' : 'Anonymous business-state read did not return the expected explicit permission denial.' };
  } catch (error) { failed("authHealth", error, "Auth health request failed before a usable response."); }
} else results.authHealth = { ok: false, code: "CONFIG_INCOMPLETE", description: "A valid HTTPS project URL and anonymous key are required." };

if (validUrl && url && service) {
  try {
    const client = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(12_000) }) } });
    const probes = await Promise.allSettled([
      (async () => {
        const { error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
        if (error) { failed("adminRead", error, "Service key could not perform the read-only admin check."); return; }
        results.adminRead = { ok: true, description: "Read-only Auth admin access is available. No user records were printed." };
      })(),
      (async () => {
        const { data, error } = await client.storage.getBucket(process.env.SUPABASE_STORAGE_BUCKET || "grammar-loop");
        if (error || !data) { failed("privateBucket", error, "Configured bucket is missing or cannot be read."); return; }
        results.privateBucket = { ok: !data.public, description: data.public ? "Bucket exists but is public." : "Configured bucket exists and is private.", details: { exists: true, private: !data.public } };
      })(),
      (async () => {
        const { data, error, status } = await client.from("gl_workspaces").select("user_id").limit(0);
        if (error) { failed("workspaceTable", error, "Workspace table is missing or cannot be read through the API."); return; }
        results.workspaceTable = { ok: Array.isArray(data), status, description: "Workspace table GET with limit 0 checked. No rows were read.", details: { responseIsArray: Array.isArray(data) } };
      })(),
    ]);
    for (let index = 0; index < probes.length; index++) if (probes[index].status === "rejected") failed(["adminRead", "privateBucket", "workspaceTable"][index], (probes[index] as PromiseRejectedResult).reason, "Read-only Supabase check failed before a usable response.");
  } catch (error) { failed("serviceClient", error, "Service client could not be initialized."); }
} else results.serviceClient = { ok: false, code: "CONFIG_INCOMPLETE", description: "A valid HTTPS project URL and service key are required." };

if (databaseUrl) {
  let client: pg.Client | undefined;
  try {
    const parsed = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) throw { code: "INVALID_DATABASE_SCHEME" };
    const passwordPlaceholder = /[<>\[\]]/.test(decodeURIComponent(parsed.password));
    if (passwordPlaceholder) results.databaseFormat = { ok: false, code: "POSSIBLE_PLACEHOLDER", description: "Database password contains template-style bracket characters; confirm the dashboard connection string was fully filled in." };
    else results.databaseFormat = { ok: true, description: "PostgreSQL connection string has a valid URL structure." };
    client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 12_000, query_timeout: 12_000 });
    client.on("error", () => {});
    await client.connect();
    await client.query("begin read only");
    const check = await client.query("select 1 as ok");
    results.postgresSelect = { ok: check.rows[0]?.ok === 1, description: "PostgreSQL connection and SELECT 1 succeeded in a read-only transaction." };
    const permissions = await client.query(`select
      current_setting('server_version_num')::integer >= 130000 as compatible_version,
      exists(select 1 from pg_namespace where nspname = 'pgboss') as queue_schema_exists,
      has_database_privilege(current_user, current_database(), 'CREATE') as can_create_schema,
      case when exists(select 1 from pg_namespace where nspname = 'pgboss')
        then has_schema_privilege(current_user, 'pgboss', 'CREATE') else false end as can_use_queue_schema,
      to_regclass('public.gl_workspaces') is not null as workspace_table_exists`);
    const row = permissions.rows[0];
    results.queueConnection = { ok: Boolean(row.compatible_version && (row.can_use_queue_schema || row.can_create_schema)), description: "Read-only queue prerequisites checked; pg-boss was not started and no schema was created.", details: { compatibleVersion: row.compatible_version, queueSchemaExists: row.queue_schema_exists, canCreateSchema: row.can_create_schema, canUseQueueSchema: row.can_use_queue_schema, workspaceTableExists: row.workspace_table_exists } };
    await client.query("rollback");
  } catch (error) { failed("postgresSelect", error, "PostgreSQL read-only connection check failed. No database changes were attempted."); }
  finally { await client?.end().catch(() => {}); }
} else results.postgresSelect = { ok: false, code: "CONFIG_INCOMPLETE", description: "Database connection string is not configured." };

console.log(JSON.stringify({ checkedAt: new Date().toISOString(), mode: 'read-only', environment: { loaded: true, presence, storageMode: process.env.STORAGE_MODE === "supabase" ? "supabase" : "local", consistency }, results }, null, 2));
