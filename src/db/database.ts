import fs from 'node:fs';
import path from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { env } from '../config/env';
import { createLogger } from '../utils/logger';

const log = createLogger('db');

/**
 * Estagios do funil. A ordem importa: `STAGE_ORDER` e usada para impedir que o
 * lead regrida de estagio por causa de uma classificacao ruidosa do Gemini.
 */
export const FUNNEL_STAGES = [
  'novo',
  'qualificacao',
  'apresentacao',
  'objecao',
  'registo_enviado',
  'registado',
  'deposito_enviado',
  'comprovativo_recebido',
  'acesso_liberado',
  'perdido',
] as const;

/**
 * Nomes anteriores dos estagios (PT-BR, antes do passo do comprovativo).
 * Sem este mapa, um lead a meio do funil voltaria a 'novo' no primeiro deploy
 * e o estrategista recomecaria a conversa do zero com quem ja estava adiantado.
 */
const LEGACY_STAGES: Record<string, FunnelStage> = {
  cadastro_enviado: 'registo_enviado',
  cadastrado: 'registado',
  depositado: 'acesso_liberado',
};

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const STAGE_ORDER = new Map<FunnelStage, number>(
  FUNNEL_STAGES.map((stage, index) => [stage, index]),
);

export type MessageRole = 'user' | 'assistant';

export interface Lead {
  chatId: number;
  /** Quando o lead disse que ia tratar disto (UTC), ou null. */
  promisedAt: string | null;
  /** O que ele disse, para o lembrete nao soar generico. */
  promiseNote: string | null;
  firstName: string | null;
  username: string | null;
  languageCode: string | null;
  stage: FunnelStage;
  notes: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: number;
  chatId: number;
  role: MessageRole;
  content: string;
  directive: string | null;
  createdAt: string;
}

/**
 * Estagios que contam como conversao para efeitos de aprendizagem: o lead
 * chegou ao deposito. Antes disso nao ha prova de que a abordagem resultou.
 */
export const CONVERTED_STAGES: readonly FunnelStage[] = [
  'deposito_enviado',
  'comprovativo_recebido',
  'acesso_liberado',
];

/** Uma abordagem que ja levou um lead ate ao deposito. */
export interface PlaybookEntry {
  profile: string;
  objection: string;
  directive: string;
  cta: string;
}

/** Comprovativo de deposito enviado pelo lead, a espera de validacao humana. */
export interface DepositProof {
  id: number;
  chatId: number;
  leadName: string | null;
  username: string | null;
  fileId: string;
  messageId: number | null;
  status: 'pendente' | 'aprovado' | 'recusado';
  createdAt: string;
}

/** Publicos do remarketing: quem ainda nao depositou, e quem ja esta no VIP. */
export type RemarketingAudience = 'nao_convertido' | 'vip' | 'promessa';

export interface FunnelStats {
  totalLeads: number;
  totalMessages: number;
  byStage: Record<string, number>;
  /** Comprovativos a espera de alguem os validar. */
  pendingProofs: number;
  /** Leads que prometeram depositar e ainda nao foram lembrados. */
  pendingPromises: number;
}

interface LeadRow {
  chat_id: number;
  promised_at: string | null;
  promise_note: string | null;
  first_name: string | null;
  username: string | null;
  language_code: string | null;
  stage: string;
  notes: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: number;
  chat_id: number;
  role: string;
  content: string;
  directive: string | null;
  created_at: string;
}

function ensureDirectory(file: string): void {
  if (file === ':memory:') return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

ensureDirectory(env.databaseFile);

export const db = new DatabaseSync(env.databaseFile);

// node:sqlite nao expoe .pragma(); os PRAGMAs vao por exec().
// WAL nao se aplica a bancos em memoria, entao so e ligado em arquivo.
if (env.databaseFile !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL');
}

db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    chat_id       INTEGER PRIMARY KEY,
    first_name    TEXT,
    username      TEXT,
    language_code TEXT,
    stage         TEXT NOT NULL DEFAULT 'novo',
    notes         TEXT,
    message_count INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    INTEGER NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content    TEXT NOT NULL,
    directive  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS deposit_proofs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     INTEGER NOT NULL REFERENCES leads(chat_id) ON DELETE CASCADE,
    lead_name   TEXT,
    username    TEXT,
    file_id     TEXT NOT NULL,
    message_id  INTEGER,
    status      TEXT NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente', 'aprovado', 'recusado')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_proofs_status ON deposit_proofs (status, id DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage);
`);

/**
 * O SQLite nao tem ADD COLUMN IF NOT EXISTS, e um deploy sobre uma base ja
 * existente teria de a apagar para ganhar colunas novas — com o historico dos
 * leads dentro. Daí a migracao a mao.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  log.info(`migracao: ${table}.${column} adicionada`);
}

addColumnIfMissing('leads', 'last_remarketing_at', 'TEXT');
addColumnIfMissing('leads', 'remarketing_touches', 'INTEGER NOT NULL DEFAULT 0');
addColumnIfMissing('leads', 'blocked', 'INTEGER NOT NULL DEFAULT 0');
// Estado "promessa de deposito": instante UTC combinado com o lead.
addColumnIfMissing('leads', 'promised_at', 'TEXT');
addColumnIfMissing('leads', 'promise_note', 'TEXT');

db.exec(`
  CREATE TABLE IF NOT EXISTS remarketing_runs (
    slot       TEXT NOT NULL,
    run_date   TEXT NOT NULL,
    audience   TEXT NOT NULL,
    sent       INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (slot, run_date, audience)
  );
`);

log.info(`SQLite pronto em ${env.databaseFile}`);

/**
 * O node:sqlite nao tem o helper `transaction()` do better-sqlite3, entao a
 * transacao e explicita. Sem ela, uma falha entre inserir a mensagem e somar
 * o contador do lead deixaria os dois fora de sincronia.
 */
function inTransaction<T>(run: () => T): T {
  db.exec('BEGIN');

  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * O node:sqlite tipa toda linha como Record<string, SQLOutputValue>. A forma
 * real de cada tabela e conhecida pelo schema logo acima, e os mapeadores
 * abaixo (mapLead/mapMessage) sao o unico lugar que le esses campos — entao a
 * conversao fica concentrada aqui em vez de espalhada por cada consulta.
 */
function asRow<T>(value: unknown): T | undefined {
  return value as T | undefined;
}

function asRows<T>(value: unknown): T[] {
  return value as T[];
}

function toStage(value: string): FunnelStage {
  if (STAGE_ORDER.has(value as FunnelStage)) return value as FunnelStage;
  return LEGACY_STAGES[value] ?? 'novo';
}

function mapLead(row: LeadRow): Lead {
  return {
    chatId: row.chat_id,
    promisedAt: row.promised_at,
    promiseNote: row.promise_note,
    firstName: row.first_name,
    username: row.username,
    languageCode: row.language_code,
    stage: toStage(row.stage),
    notes: row.notes,
    messageCount: row.message_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: MessageRow): StoredMessage {
  return {
    id: row.id,
    chatId: row.chat_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    directive: row.directive,
    createdAt: row.created_at,
  };
}

const statements = {
  upsertLead: db.prepare(`
    INSERT INTO leads (chat_id, first_name, username, language_code)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, leads.first_name),
      username      = COALESCE(excluded.username, leads.username),
      language_code = COALESCE(excluded.language_code, leads.language_code),
      updated_at    = datetime('now')
  `),
  getLead: db.prepare('SELECT * FROM leads WHERE chat_id = ?'),
  updateStage: db.prepare(`
    UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ?
  `),
  updateNotes: db.prepare(`
    UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE chat_id = ?
  `),
  bumpMessageCount: db.prepare(`
    UPDATE leads
       SET message_count = message_count + 1,
           updated_at    = datetime('now')
     WHERE chat_id = ?
  `),
  insertMessage: db.prepare(`
    INSERT INTO messages (chat_id, role, content, directive) VALUES (?, ?, ?, ?)
  `),
  recentMessages: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
  deleteMessages: db.prepare('DELETE FROM messages WHERE chat_id = ?'),
  deleteLead: db.prepare('DELETE FROM leads WHERE chat_id = ?'),
  countLeads: db.prepare('SELECT COUNT(*) AS total FROM leads'),
  countMessages: db.prepare('SELECT COUNT(*) AS total FROM messages'),
  countByStage: db.prepare('SELECT stage, COUNT(*) AS total FROM leads GROUP BY stage'),
  insertProof: db.prepare(`
    INSERT INTO deposit_proofs (chat_id, lead_name, username, file_id, message_id)
    VALUES (?, ?, ?, ?, ?)
  `),
  countPendingProofs: db.prepare(
    "SELECT COUNT(*) AS total FROM deposit_proofs WHERE status = 'pendente'",
  ),
  deleteProofs: db.prepare('DELETE FROM deposit_proofs WHERE chat_id = ?'),
  claimSlot: db.prepare(`
    INSERT OR IGNORE INTO remarketing_runs (slot, run_date, audience) VALUES (?, ?, ?)
  `),
  recordSlotSent: db.prepare(`
    UPDATE remarketing_runs SET sent = ? WHERE slot = ? AND run_date = ? AND audience = ?
  `),
  markRemarketed: db.prepare(`
    UPDATE leads
       SET last_remarketing_at = datetime('now'),
           remarketing_touches = remarketing_touches + 1
     WHERE chat_id = ?
  `),
  markBlocked: db.prepare("UPDATE leads SET blocked = 1 WHERE chat_id = ?"),
  setPromise: db.prepare(`
    UPDATE leads SET promised_at = ?, promise_note = ?, updated_at = datetime('now')
     WHERE chat_id = ?
  `),
  clearPromise: db.prepare(
    'UPDATE leads SET promised_at = NULL, promise_note = NULL WHERE chat_id = ?',
  ),
  duePromises: db.prepare(`
    SELECT * FROM leads
     WHERE blocked = 0
       AND promised_at IS NOT NULL
       AND promised_at <= ?
       AND stage NOT IN ('perdido', ${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
     ORDER BY promised_at ASC
     LIMIT ?
  `),
  countPromises: db.prepare(
    'SELECT COUNT(*) AS total FROM leads WHERE promised_at IS NOT NULL',
  ),
  targetsNotConverted: db.prepare(`
    SELECT * FROM leads
     WHERE blocked = 0
       AND stage NOT IN ('perdido', ${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
       AND remarketing_touches < ?
       -- Quem prometeu ja tem lembrete proprio marcado; dois no mesmo dia
       -- e que fazem a pessoa bloquear o bot.
       AND promised_at IS NULL
       AND updated_at <= datetime('now', ?)
       AND (last_remarketing_at IS NULL OR last_remarketing_at <= datetime('now', ?))
     ORDER BY updated_at ASC
     LIMIT ?
  `),
  targetsVip: db.prepare(`
    SELECT * FROM leads
     WHERE blocked = 0
       AND stage IN (${CONVERTED_STAGES.map((stage) => `'${stage}'`).join(', ')})
       AND (last_remarketing_at IS NULL OR last_remarketing_at <= datetime('now', ?))
     ORDER BY updated_at ASC
     LIMIT ?
  `),
  convertedDirectives: db.prepare(`
    SELECT m.directive AS directive
      FROM messages m
      JOIN leads l ON l.chat_id = m.chat_id
     WHERE l.stage IN (${CONVERTED_STAGES.map(() => '?').join(', ')})
       AND m.role = 'assistant'
       AND m.directive IS NOT NULL
       AND m.chat_id <> ?
     ORDER BY m.id DESC
     LIMIT ?
  `),
};

/**
 * Abordagens que ja levaram leads ate ao deposito, para o estrategista as
 * reaproveitar. Le as diretrizes gravadas nas conversas convertidas — e por
 * isso que cada resposta guarda o JSON da diretriz que a gerou.
 *
 * Fica deduplicado por objecao: dez diretrizes a responder a mesma duvida
 * ensinam o mesmo e so gastam contexto. O proprio lead e excluido, para o
 * estrategista nao aprender com aquilo que acabou de dizer.
 */
export function getConversionPlaybook(params: {
  excludeChatId: number;
  limit?: number;
}): PlaybookEntry[] {
  const limit = params.limit ?? 6;

  // Le mais do que precisa porque a deduplicacao por objecao descarta muitas.
  const rows = asRows<{ directive: string }>(
    statements.convertedDirectives.all(...CONVERTED_STAGES, params.excludeChatId, limit * 8),
  );

  const seen = new Set<string>();
  const playbook: PlaybookEntry[] = [];

  for (const row of rows) {
    if (playbook.length >= limit) break;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.directive) as Record<string, unknown>;
    } catch {
      continue;
    }

    const objection = typeof parsed.objection === 'string' ? parsed.objection.trim() : '';
    const directive = typeof parsed.directive === 'string' ? parsed.directive.trim() : '';

    // Sem objecao nao ha licao: e so o funil a andar para a frente sozinho.
    if (!directive || !objection || objection.toLowerCase() === 'nenhuma') continue;

    const profile = typeof parsed.profile === 'string' ? parsed.profile : 'indefinido';
    const key = `${profile}|${objection.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    playbook.push({
      profile,
      objection,
      directive,
      cta: typeof parsed.cta === 'string' ? parsed.cta : '',
    });
  }

  return playbook;
}

/**
 * Guarda o comprovativo enviado pelo lead. Nao aprova nada: o registo fica
 * pendente para uma pessoa validar, que e a regra do funil — o bot nunca
 * liberta acesso sozinho.
 */
export function recordDepositProof(input: {
  chatId: number;
  leadName: string | null;
  username: string | null;
  fileId: string;
  messageId: number | null;
}): DepositProof {
  const result = statements.insertProof.run(
    input.chatId,
    input.leadName,
    input.username,
    input.fileId,
    input.messageId,
  );

  return {
    id: Number(result.lastInsertRowid),
    chatId: input.chatId,
    leadName: input.leadName,
    username: input.username,
    fileId: input.fileId,
    messageId: input.messageId,
    status: 'pendente',
    createdAt: new Date().toISOString(),
  };
}

/** Cria o lead se ele ainda nao existir e devolve o registro atualizado. */
export function upsertLead(input: {
  chatId: number;
  firstName?: string | null;
  username?: string | null;
  languageCode?: string | null;
}): Lead {
  statements.upsertLead.run(
    input.chatId,
    input.firstName ?? null,
    input.username ?? null,
    input.languageCode ?? null,
  );

  const row = asRow<LeadRow>(statements.getLead.get(input.chatId));

  if (!row) {
    throw new Error(`Falha ao persistir o lead ${input.chatId}`);
  }

  return mapLead(row);
}

export function getLead(chatId: number): Lead | null {
  const row = asRow<LeadRow>(statements.getLead.get(chatId));
  return row ? mapLead(row) : null;
}

/**
 * Avanca o estagio do lead. Retrocessos sao ignorados — a unica excecao e
 * `perdido`, que pode ser marcado a qualquer momento (opt-out do lead).
 */
export function advanceStage(chatId: number, next: FunnelStage): FunnelStage {
  const lead = getLead(chatId);
  const current = lead?.stage ?? 'novo';

  if (next === current) return current;

  if (next !== 'perdido' && current !== 'perdido') {
    const currentIndex = STAGE_ORDER.get(current) ?? 0;
    const nextIndex = STAGE_ORDER.get(next) ?? 0;
    if (nextIndex < currentIndex) return current;
  }

  statements.updateStage.run(next, chatId);
  return next;
}

export function setNotes(chatId: number, notes: string | null): void {
  statements.updateNotes.run(notes, chatId);
}

export function addMessage(input: {
  chatId: number;
  role: MessageRole;
  content: string;
  directive?: string | null;
}): void {
  inTransaction(() => {
    statements.insertMessage.run(
      input.chatId,
      input.role,
      input.content,
      input.directive ?? null,
    );
    statements.bumpMessageCount.run(input.chatId);
  });
}

/** Janela de memoria enviada as duas IAs, em ordem cronologica. */
export function getRecentMessages(chatId: number, limit = env.HISTORY_WINDOW): StoredMessage[] {
  const rows = asRows<MessageRow>(statements.recentMessages.all(chatId, limit));
  return rows.map(mapMessage);
}

/** Apaga o historico do chat, mantendo o lead (usado pelo /reset). */
export function clearHistory(chatId: number): void {
  statements.deleteMessages.run(chatId);
}

/** Remove lead e historico — usado pelo /parar, para respeitar o opt-out. */
export function forgetLead(chatId: number): void {
  inTransaction(() => {
    statements.deleteProofs.run(chatId);
    statements.deleteMessages.run(chatId);
    statements.deleteLead.run(chatId);
  });
}

/**
 * Reserva o envio de um slot para hoje. Devolve false se ja tinha sido
 * reservado: o Render reinicia o servico com frequencia, e sem esta marca na
 * base de dados cada reinicio dentro da janela reenviaria tudo outra vez.
 */
export function claimRemarketingSlot(
  slot: string,
  runDate: string,
  audience: RemarketingAudience,
): boolean {
  return statements.claimSlot.run(slot, runDate, audience).changes > 0;
}

export function recordRemarketingSent(
  slot: string,
  runDate: string,
  audience: RemarketingAudience,
  sent: number,
): void {
  statements.recordSlotSent.run(sent, slot, runDate, audience);
}

/**
 * Leads a contactar. Fora ficam: quem bloqueou o bot, quem esta em 'perdido'
 * (inclui quem pediu para parar e quem mencionou divida ou vicio), quem ja
 * levou o numero maximo de lembretes, e quem falou connosco ha pouco — a esse
 * nao se manda um lembrete, responde-se.
 */
export function getRemarketingTargets(params: {
  audience: RemarketingAudience;
  maxTouches: number;
  quietHours: number;
  limit: number;
}): Lead[] {
  const quiet = `-${params.quietHours} hours`;

  const rows =
    params.audience === 'vip'
      ? asRows<LeadRow>(statements.targetsVip.all(quiet, params.limit))
      : asRows<LeadRow>(
          statements.targetsNotConverted.all(params.maxTouches, quiet, quiet, params.limit),
        );

  return rows.map(mapLead);
}

export function markRemarketed(chatId: number): void {
  statements.markRemarketed.run(chatId);
}

/** O lead bloqueou o bot: nunca mais lhe mandamos nada. */
export function markBlocked(chatId: number): void {
  statements.markBlocked.run(chatId);
}

/**
 * Regista que o lead se comprometeu a tratar disto a uma certa hora. Uma
 * promessa nova substitui a anterior: vale a ultima coisa que ele disse.
 */
export function setDepositPromise(chatId: number, whenUtc: string, note: string | null): void {
  statements.setPromise.run(whenUtc, note, chatId);
}

export function clearDepositPromise(chatId: number): void {
  statements.clearPromise.run(chatId);
}

/**
 * Promessas vencidas. Quem ja depositou ou saiu do funil nao aparece — o
 * lembrete e para quem disse que ia tratar disto e ainda nao tratou.
 */
export function getDuePromises(nowUtc: string, limit: number): Lead[] {
  return asRows<LeadRow>(statements.duePromises.all(nowUtc, limit)).map(mapLead);
}

export function getStats(): FunnelStats {
  const leads = asRow<{ total: number }>(statements.countLeads.get());
  const messages = asRow<{ total: number }>(statements.countMessages.get());
  const stages = asRows<{ stage: string; total: number }>(statements.countByStage.all());
  const proofs = asRow<{ total: number }>(statements.countPendingProofs.get());
  const promises = asRow<{ total: number }>(statements.countPromises.get());

  const byStage: Record<string, number> = {};
  for (const row of stages) {
    byStage[row.stage] = row.total;
  }

  return {
    totalLeads: leads?.total ?? 0,
    totalMessages: messages?.total ?? 0,
    byStage,
    pendingProofs: proofs?.total ?? 0,
    pendingPromises: promises?.total ?? 0,
  };
}

export function closeDatabase(): void {
  try {
    db.close();
    log.info('Conexao SQLite encerrada');
  } catch (error) {
    log.warn('Falha ao encerrar o SQLite', error);
  }
}
