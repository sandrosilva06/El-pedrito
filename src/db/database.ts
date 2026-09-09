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

  CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages (chat_id, id DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads (stage);
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
    statements.deleteMessages.run(chatId);
    statements.deleteLead.run(chatId);
  });
}

export function getStats(): FunnelStats {
  const leads = asRow<{ total: number }>(statements.countLeads.get());
  const messages = asRow<{ total: number }>(statements.countMessages.get());
  const stages = asRows<{ stage: string; total: number }>(statements.countByStage.all());

  const byStage: Record<string, number> = {};
  for (const row of stages) {
    byStage[row.stage] = row.total;
  }

  return { totalLeads: leads?.total ?? 0, totalMessages: messages?.total ?? 0, byStage };
}

export function closeDatabase(): void {
  try {
    db.close();
    log.info('Conexao SQLite encerrada');
  } catch (error) {
    log.warn('Falha ao encerrar o SQLite', error);
  }
}
