import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

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
  'cadastro_enviado',
  'cadastrado',
  'deposito_enviado',
  'depositado',
  'perdido',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

const STAGE_ORDER = new Map<FunnelStage, number>(
  FUNNEL_STAGES.map((stage, index) => [stage, index]),
);

export type MessageRole = 'user' | 'assistant';

export interface Lead {
  chatId: number;
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

export interface FunnelStats {
  totalLeads: number;
  totalMessages: number;
  byStage: Record<string, number>;
}

interface LeadRow {
  chat_id: number;
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

export const db = new Database(env.databaseFile);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage);
`);

log.info(`SQLite pronto em ${env.databaseFile}`);

function toStage(value: string): FunnelStage {
  return STAGE_ORDER.has(value as FunnelStage) ? (value as FunnelStage) : 'novo';
}

function mapLead(row: LeadRow): Lead {
  return {
    chatId: row.chat_id,
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
  upsertLead: db.prepare<[number, string | null, string | null, string | null]>(`
    INSERT INTO leads (chat_id, first_name, username, language_code)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET
      first_name    = COALESCE(excluded.first_name, leads.first_name),
      username      = COALESCE(excluded.username, leads.username),
      language_code = COALESCE(excluded.language_code, leads.language_code),
      updated_at    = datetime('now')
  `),
  getLead: db.prepare<[number]>('SELECT * FROM leads WHERE chat_id = ?'),
  updateStage: db.prepare<[string, number]>(`
    UPDATE leads SET stage = ?, updated_at = datetime('now') WHERE chat_id = ?
  `),
  updateNotes: db.prepare<[string | null, number]>(`
    UPDATE leads SET notes = ?, updated_at = datetime('now') WHERE chat_id = ?
  `),
  bumpMessageCount: db.prepare<[number]>(`
    UPDATE leads
       SET message_count = message_count + 1,
           updated_at    = datetime('now')
     WHERE chat_id = ?
  `),
  insertMessage: db.prepare<[number, string, string, string | null]>(`
    INSERT INTO messages (chat_id, role, content, directive) VALUES (?, ?, ?, ?)
  `),
  recentMessages: db.prepare<[number, number]>(`
    SELECT * FROM (
      SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?
    ) ORDER BY id ASC
  `),
  deleteMessages: db.prepare<[number]>('DELETE FROM messages WHERE chat_id = ?'),
  deleteLead: db.prepare<[number]>('DELETE FROM leads WHERE chat_id = ?'),
  countLeads: db.prepare('SELECT COUNT(*) AS total FROM leads'),
  countMessages: db.prepare('SELECT COUNT(*) AS total FROM messages'),
  countByStage: db.prepare('SELECT stage, COUNT(*) AS total FROM leads GROUP BY stage'),
};

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

  const row = statements.getLead.get(input.chatId) as LeadRow | undefined;

  if (!row) {
    throw new Error(`Falha ao persistir o lead ${input.chatId}`);
  }

  return mapLead(row);
}

export function getLead(chatId: number): Lead | null {
  const row = statements.getLead.get(chatId) as LeadRow | undefined;
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
  const persist = db.transaction(() => {
    statements.insertMessage.run(
      input.chatId,
      input.role,
      input.content,
      input.directive ?? null,
    );
    statements.bumpMessageCount.run(input.chatId);
  });

  persist();
}

/** Janela de memoria enviada as duas IAs, em ordem cronologica. */
export function getRecentMessages(chatId: number, limit = env.HISTORY_WINDOW): StoredMessage[] {
  const rows = statements.recentMessages.all(chatId, limit) as MessageRow[];
  return rows.map(mapMessage);
}

/** Apaga o historico do chat, mantendo o lead (usado pelo /reset). */
export function clearHistory(chatId: number): void {
  statements.deleteMessages.run(chatId);
}

/** Remove lead e historico — usado pelo /parar, para respeitar o opt-out. */
export function forgetLead(chatId: number): void {
  const purge = db.transaction(() => {
    statements.deleteMessages.run(chatId);
    statements.deleteLead.run(chatId);
  });

  purge();
}

export function getStats(): FunnelStats {
  const leads = statements.countLeads.get() as { total: number };
  const messages = statements.countMessages.get() as { total: number };
  const stages = statements.countByStage.all() as Array<{ stage: string; total: number }>;

  const byStage: Record<string, number> = {};
  for (const row of stages) {
    byStage[row.stage] = row.total;
  }

  return { totalLeads: leads.total, totalMessages: messages.total, byStage };
}

export function closeDatabase(): void {
  try {
    db.close();
    log.info('Conexao SQLite encerrada');
  } catch (error) {
    log.warn('Falha ao encerrar o SQLite', error);
  }
}
