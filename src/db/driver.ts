/**
 * A camada que fala com a base de dados, seja ela qual for.
 *
 * Havia SQLite dentro da pasta da aplicacao, e cada deploy do Render apagava
 * tudo: leads, conversas, estado do remarketing. Isto abre a porta ao Postgres
 * (Supabase, Neon, Render) sem deitar fora o SQLite, que continua a servir o
 * desenvolvimento e os testes.
 *
 * A escolha e uma variavel de ambiente:
 *   DATABASE_URL definido  -> Postgres
 *   DATABASE_URL vazio     -> SQLite, como sempre
 *
 * Ter os dois nao e indecisao: e o que permite trocar sem parar o funil, e
 * voltar atras apagando uma variavel se alguma coisa correr mal.
 *
 * O SQL e escrito UMA vez, num subconjunto que os dois percebem. O que nao e
 * portavel fica aqui:
 *
 * - Marcadores: escreve-se sempre "?", e o driver do Postgres numera-os.
 * - Datas: escreve-se sempre datetime('now') e datetime('now', ?), como no
 *   SQLite, e o driver do Postgres traduz. Assim as datas continuam a ser
 *   texto "YYYY-MM-DD HH:MM:SS" em UTC nos dois lados, e todo o codigo que ja
 *   as le e compara continua a funcionar sem uma unica alteracao.
 * - Inteiros grandes: o node-postgres devolve COUNT(*) como string, porque um
 *   bigint nao cabe num number. Aqui sao convertidos, senao um total vinha
 *   como "12" e as contas silenciosamente davam concatenacao.
 */
import { DatabaseSync } from 'node:sqlite';

import { createLogger } from '../utils/logger';

const log = createLogger('db');

export interface RunResult {
  /** Linhas afectadas. */
  changes: number;
}

/**
 * O minimo que a aplicacao precisa de uma base de dados. Tudo assincrono,
 * porque falar com o Postgres e rede — e uma funcao que hoje e sincrona e
 * amanha nao, parte tudo em silencio.
 */
export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<RunResult>;
  exec(sql: string): Promise<void>;
  /**
   * Corre tudo dentro de uma transacao, na MESMA ligacao.
   *
   * No Postgres isto nao e detalhe: um pool distribui cada query por uma
   * ligacao livre, e um BEGIN numa ligacao com o COMMIT noutra nao abre
   * transacao nenhuma — as escritas ficavam soltas e uma falha a meio deixava
   * a mensagem gravada sem o contador do lead somado.
   */
  transaction<T>(run: (tx: Driver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Traduz o SQL portavel para o dialecto do Postgres.
 *
 * Exportada para ser testada directamente: e o unico sitio do sistema onde uma
 * troca de texto mal feita daria erros de SQL em producao, e um teste que
 * compara strings apanha isso em milissegundos.
 */
export function toPostgres(sql: string): string {
  // datetime('now', ?) -> agora mais o intervalo que vem no parametro.
  // O "?" e mantido no sitio para a ordem dos parametros nao mudar.
  let out = sql.replace(
    /datetime\(\s*'now'\s*,\s*\?\s*\)/g,
    "to_char((now() AT TIME ZONE 'utc') + (?)::interval, 'YYYY-MM-DD HH24:MI:SS')",
  );

  // datetime('now') -> agora, no mesmo formato de texto do SQLite.
  out = out.replace(
    /datetime\(\s*'now'\s*\)/g,
    "to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')",
  );

  // Marcadores numerados, pela ordem em que aparecem.
  let n = 0;
  out = out.replace(/\?/g, () => `$${++n}`);

  return out;
}

/** SQLite, como sempre: sincrono por baixo, com a mesma interface assincrona. */
class SqliteDriver implements Driver {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: DatabaseSync) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(result.changes) };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  /**
   * Fila das transacoes.
   *
   * O SQLite tem UMA ligacao, e com transacoes assincronas duas escritas em
   * simultaneo entrelacam-se: a segunda faz BEGIN antes de a primeira ter
   * feito COMMIT e o SQLite recusa ("cannot start a transaction within a
   * transaction"). Acontecia a serio — dois leads a escrever ao mesmo tempo
   * chegam sempre juntos a hora de ponta.
   *
   * No Postgres isto nao e preciso, porque cada transacao leva uma ligacao so
   * dela do pool.
   */
  private fila: Promise<unknown> = Promise.resolve();

  async transaction<T>(run: (tx: Driver) => Promise<T>): Promise<T> {
    const proxima = this.fila.then(async () => {
      this.db.exec('BEGIN');

      try {
        const result = await run(this);
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    });

    // A fila nunca pode ficar presa a um erro: sem o catch, uma transacao que
    // falhasse bloqueava todas as seguintes.
    this.fila = proxima.catch(() => undefined);

    return proxima;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Postgres, por rede, com um pool de ligacoes. */
class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly pool: any) {}

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.pool.query(toPostgres(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.pool.query(toPostgres(sql), params);
    return result.rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.pool.query(toPostgres(sql), params);
    return { changes: Number(result.rowCount ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    // O exec leva DDL, que pode trazer varias instrucoes de uma vez. Nao passa
    // pela traducao de marcadores: nao ha parametros em DDL.
    await this.pool.query(sql);
  }

  async transaction<T>(run: (tx: Driver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // O driver que vai para dentro esta preso a ESTA ligacao, senao as
      // queries de dentro da transacao saiam por outra do pool.
      const result = await run(new PostgresDriver(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    // Um cliente preso a uma transacao nao fecha o pool; so o pool o faz.
    if (typeof this.pool.end === 'function') await this.pool.end();
  }
}

/**
 * Abre a ligacao certa para o ambiente.
 *
 * O Postgres so entra quando ha DATABASE_URL. Sem ela, nada muda em relacao ao
 * que ja estava a correr.
 */
export async function openDriver(params: {
  databaseUrl: string | null;
  sqliteFile: string;
}): Promise<Driver> {
  if (params.databaseUrl) {
    // Carregado aqui e nao no topo: quem corre em SQLite nao tem de ter o
    // driver do Postgres instalado nem pago o custo de o carregar.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pg = require('pg') as {
      Pool: new (config: Record<string, unknown>) => unknown;
      types: { setTypeParser: (id: number, fn: (value: string) => unknown) => void };
    };

    // int8 (bigint) vem como string por omissao, porque nem todos cabem num
    // number. Os nossos cabem — sao contagens e chat_ids — e receber "12" onde
    // se esperava 12 dava contas erradas sem erro nenhum.
    pg.types.setTypeParser(20, (value: string) => Number(value));

    const pool = new pg.Pool({
      connectionString: params.databaseUrl,
      // Supabase, Neon e Render servem TLS com cadeias que o Node nao valida
      // por omissao. A ligacao continua cifrada.
      ssl: params.databaseUrl.includes('localhost') || params.databaseUrl.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    log.info('base de dados: Postgres');
    return new PostgresDriver(pool);
  }

  const db = new DatabaseSync(params.sqliteFile);

  // WAL: leituras nao bloqueiam escritas. So faz sentido em ficheiro.
  if (params.sqliteFile !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');

  log.info(`base de dados: SQLite em ${params.sqliteFile}`);
  return new SqliteDriver(db);
}
