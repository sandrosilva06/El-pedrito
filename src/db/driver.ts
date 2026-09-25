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

/**
 * A ligacao morreu por baixo dos pes, e a query nem chegou a correr.
 *
 * O pooler do Supabase fecha ligacoes paradas sem avisar ninguem, e o pool
 * continua a entregar o cliente morto a quem pedir a seguir. Visto em
 * producao, varias vezes por dia:
 *
 *   ERROR [agendador] falha ao enviar lembretes de promessa
 *         error: terminating connection due to administrator command
 *
 * Nestes casos o servidor cortou ANTES de executar seja o que for, por isso
 * repetir nao duplica nada — e a unica classe de erro do Postgres de que isso
 * se pode dizer com seguranca. Tudo o resto (chave duplicada, sintaxe, uma
 * restricao violada) sobe como sempre.
 */
function ligacaoMorreu(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  if (!e) return false;

  // 57P01 admin shutdown, 57P02 crash shutdown, 57P03 cannot connect now,
  // 08006/08003/08000 falhas de ligacao.
  if (e.code && ['57P01', '57P02', '57P03', '08006', '08003', '08000'].includes(e.code)) {
    return true;
  }

  // O node-postgres mata o cliente antes de haver codigo de erro quando o
  // socket cai a meio: so fica a mensagem.
  return /Connection terminated|Client has encountered a connection error|socket hang up/i.test(
    e.message ?? '',
  );
}

/** Postgres, por rede, com um pool de ligacoes. */
class PostgresDriver implements Driver {
  readonly dialect = 'postgres' as const;

  /**
   * `dentroDeTransacao` distingue o driver do pool do driver preso a UMA
   * ligacao. Dentro de uma transacao nao se repete nada: a ligacao que morreu
   * levou o BEGIN com ela, e repetir uma query solta escrevia-a fora da
   * transacao. Essa sobe para quem chamou, que faz ROLLBACK e desiste.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly pool: any, private readonly dentroDeTransacao = false) {}

  /** Corre a query, e repete UMA vez se a ligacao tiver morrido antes de correr. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async query(sql: string, params?: unknown[]): Promise<any> {
    try {
      return await this.pool.query(sql, params);
    } catch (error) {
      if (this.dentroDeTransacao || !ligacaoMorreu(error)) throw error;

      // A segunda tentativa vai buscar outra ligacao ao pool. Se essa tambem
      // estiver morta, o erro sobe: duas seguidas ja nao e uma ligacao velha,
      // e uma terceira tentativa so atrasava a noticia.
      log.warn('ligacao a base de dados caiu antes da query; a repetir uma vez');
      return await this.pool.query(sql, params);
    }
  }

  async all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.query(toPostgres(sql), params);
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const result = await this.query(toPostgres(sql), params);
    return result.rows[0] as T | undefined;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    const result = await this.query(toPostgres(sql), params);
    return { changes: Number(result.rowCount ?? 0) };
  }

  async exec(sql: string): Promise<void> {
    // O exec leva DDL, que pode trazer varias instrucoes de uma vez. Nao passa
    // pela traducao de marcadores: nao ha parametros em DDL.
    await this.query(sql);
  }

  async transaction<T>(run: (tx: Driver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();

    // Enquanto a ligacao esta emprestada, o pool deixa de ouvir os erros dela:
    // quem a tem na mao e que responde. Sem este ouvinte, uma ligacao que morra
    // a meio de uma transacao emite 'error' sem ninguem a ouvir — e um 'error'
    // sem ouvintes DERRUBA O PROCESSO.
    //
    // Nao e hipotese: o pooler do Supabase fecha ligacoes, o funil grava as
    // mensagens dentro de uma transacao, e o servico inteiro ia abaixo por uma
    // ligacao cortada. Aqui o erro fica registado e a transacao falha sozinha,
    // como qualquer outra.
    let morreu = false;
    const aoErrar = (erro: unknown) => {
      morreu = true;
      log.warn('ligacao caiu a meio de uma transacao; vai ser desfeita', erro);
    };
    client.on('error', aoErrar);

    try {
      await client.query('BEGIN');
      // O driver que vai para dentro esta preso a ESTA ligacao, senao as
      // queries de dentro da transacao saiam por outra do pool. E marcado como
      // tal para nao repetir queries: dentro de uma transacao, repetir numa
      // ligacao nova escrevia por fora dela.
      const result = await run(new PostgresDriver(client, true));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (!morreu && !ligacaoMorreu(error)) {
        // Numa ligacao morta o ROLLBACK so daria outro erro; o servidor ja
        // desfez tudo ao cortar.
        await client.query('ROLLBACK').catch(() => undefined);
      }
      throw error;
    } finally {
      client.off('error', aoErrar);
      // Uma ligacao que morreu nao volta para o pool: devolve-la punha-a outra
      // vez em circulacao, para partir a query de outra pessoa. O argumento do
      // release manda o pool deita-la fora e abrir uma nova.
      client.release(morreu ? new Error('ligacao morta') : undefined);
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
      // Mais curto do que o corte do pooler do Supabase: assim somos nos a
      // fechar as ligacoes paradas, em vez de descobrirmos que ele as fechou
      // na query seguinte.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // Mantem o socket vivo em ligacoes com pouco transito; sem isto ha
      // caminhos de rede que as cortam em silencio.
      keepAlive: true,
    });

    // Sem este ouvinte, um erro numa ligacao PARADA do pool nao tem quem o
    // apanhe — e um 'error' sem ouvintes num EventEmitter derruba o processo.
    // O funil inteiro ia abaixo porque o pooler fechou uma ligacao que ninguem
    // estava a usar.
    (pool as { on: (evento: string, fn: (erro: unknown) => void) => void }).on(
      'error',
      (erro: unknown) => {
        log.warn('ligacao parada do pool caiu (o pool repoe-a sozinho)', erro);
      },
    );

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
