import http from 'node:http';

import express from 'express';
import { webhookCallback } from 'grammy';

import { env, isProduction } from './config/env';
import {
  closeDatabase,
  initDatabase,
  getStats,
  pruneProcessedUpdates,
  restoreLeads,
  restoreVipLeads,
} from './db/database';
import { backupDatabase } from './db/backup';
import { preencherNomes } from './telegram/identidades';
import { LEADS_RECUPERADOS } from './db/leads-recuperados';
import { startRemarketingScheduler, stopRemarketingScheduler } from './scheduler/remarketing';
import { BOT_COMMANDS, bot } from './telegram/bot';
import { createInboxRouter } from './web/inbox';
import { ADMIN_HTML } from './web/page';
import { createLogger } from './utils/logger';

const log = createLogger('server');

/** Temporizador do backup periodico, para o encerramento o poder parar. */
let backupTimer: NodeJS.Timeout | null = null;

const app = express();

app.disable('x-powered-by');

/**
 * Estado do registro no Telegram, preenchido no boot. Fica no /health porque
 * "o bot nao responde" quase sempre se resolve olhando o que o Telegram acha
 * do webhook — e sem isso a unica pista fica presa nos logs da plataforma.
 */
const storage = {
  databaseFile: env.databaseFile,
  /** true = os dados nao sobrevivem ao proximo deploy. */
  ephemeral: env.databaseIsEphemeral,
};

const telegram: {
  mode: string;
  modeSource: string;
  publicUrl: string | null;
  webhookUrl: string | null;
  botUsername: string | null;
  webhookRegistered: boolean;
  pendingUpdates: number | null;
  lastError: string | null;
  error: string | null;
} = {
  mode: env.TELEGRAM_MODE,
  modeSource: env.modeSource,
  publicUrl: env.TELEGRAM_WEBHOOK_URL,
  webhookUrl:
    env.TELEGRAM_MODE === 'webhook' && env.TELEGRAM_WEBHOOK_URL
      ? `${env.TELEGRAM_WEBHOOK_URL}${env.webhookPath}`
      : null,
  botUsername: null,
  webhookRegistered: false,
  pendingUpdates: null,
  lastError: null,
  error: null,
};

app.get('/health', (_req, res) => {
  res.json({
    status: telegram.error ? 'degraded' : 'ok',
    telegram,
    storage,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/stats', async (req, res) => {
  // Endpoint interno: so responde com o segredo do webhook, para nao expor
  // metricas do funil publicamente.
  // Usa o segredo apenas quando ele foi configurado explicitamente: o valor
  // derivado do token nao e conhecido por ninguem, entao nao serve de senha.
  const provided = req.get('x-admin-token');

  if (!env.adminToken || provided !== env.adminToken) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.json(await getStats());
});

/**
 * Caixa de entrada privada.
 *
 * So existe se houver ADMIN_PASSWORD. Sem ela nao se monta nada e o catch-all
 * responde 404: uma caixa de entrada sem palavra-passe seria pior do que nao
 * haver caixa nenhuma, porque o endereco acaba sempre por circular.
 */
if (env.inboxEnabled) {
  app.get('/admin', (_req, res) => {
    res.type('html').send(ADMIN_HTML);
  });

  app.use('/api', createInboxRouter());
} else {
  log.warn(
    'caixa de entrada desligada: define ADMIN_PASSWORD (12+ caracteres) para a activar em /admin',
  );
}

// ATENCAO ao mexer aqui: webhookCallback() nao apenas devolve um handler —
// ele substitui bot.start por uma funcao que lanca, no momento em que e
// criado. Construi-lo em modo polling mata o long polling antes mesmo de
// comecar. Por isso ele so e criado quando o modo e webhook.
const webhookHandler =
  env.TELEGRAM_MODE === 'webhook'
    ? webhookCallback(bot, 'express', {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
        timeoutMilliseconds: 60_000,
      })
    : null;

// As rotas ficam registradas nos dois caminhos e nos dois modos: o caminho
// derivado do token (o que a aplicacao registra no Telegram) e o /webhook
// literal, que e o que se digita ao apontar o webhook a mao. Em polling elas
// respondem explicando o motivo — um 404 mudo esconderia justamente a
// configuracao errada que se esta tentando achar. O parser de JSON fica
// restrito a essas rotas: nenhuma outra recebe corpo.
app.post(
  [env.webhookPath, env.webhookAliasPath],
  express.json({ limit: '1mb' }),
  (req, res) => {
    if (!webhookHandler) {
      res.status(409).json({
        error: 'o servidor esta em long polling; este webhook nao entrega updates',
        hint: 'configure TELEGRAM_MODE=webhook, ou remova a variavel para o modo ser deduzido da URL publica',
      });
      return;
    }

    void webhookHandler(req, res);
  },
);

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

let server: http.Server | null = null;

async function start(): Promise<void> {
  // A porta sobe ANTES de qualquer chamada ao Telegram. As plataformas de
  // deploy derrubam o servico que nao liga a porta dentro de um prazo, e
  // bot.init() + setMyCommands sao duas idas a rede: token errado ou Telegram
  // lento significavam porta nunca ligada, deploy marcado como falho e
  // crash-loop — sem nada no /health explicando o motivo.
  server = app.listen(env.PORT, () => {
    log.info(`HTTP ouvindo na porta ${env.PORT}`);
  });

  // A base de dados abre AQUI, e nao no momento em que o modulo e importado.
  // Com o Postgres a ligacao e rede: tem de haver por quem esperar, e a porta
  // ja esta a ouvir para o Render nao derrubar o servico enquanto isto demora.
  await initDatabase();

  // A tabela de updates processados existe para nao repetir entregas, nao para
  // guardar historia. Podada no arranque e uma vez por hora.
  await pruneProcessedUpdates();
  const prune = setInterval(() => void pruneProcessedUpdates(), 60 * 60 * 1000);
  prune.unref();

  // Um disco efemero nao da erro nenhum: o bot funciona, atende, converte, e
  // perde tudo no deploy seguinte. E o tipo de falha que so se descobre quando
  // a base de leads ja desapareceu, por isso grita-se aqui.
  if (env.databaseIsEphemeral) {
    const aviso =
      `a base de dados esta em ${env.databaseFile}, dentro da pasta da aplicacao. ` +
      'Num deploy este ficheiro e descartado e perdem-se leads, historico e o ' +
      'estado do remarketing. Monta um disco persistente e aponta o ' +
      'DATABASE_PATH para o mount path (ex.: /var/data/funnel.sqlite).';

    if (isProduction) log.error(aviso);
    else log.info(`base de dados local em ${env.databaseFile} (efemera, normal em desenvolvimento)`);
  }

  // Repoe quem ja pagou. Corre SEMPRE, e nao so quando a base de dados e
  // efemera: e idempotente, e assim o estagio e o afixado ficam garantidos em
  // qualquer arranque.
  if (env.vipLeads.length > 0) {
    const repostos = await restoreVipLeads(env.vipLeads);
    log.info(
      `VIP_CHAT_IDS: ${env.vipLeads.length} lead(s) aprovados e afixados` +
        `${repostos > 0 ? `, ${repostos} recriado(s) do zero` : ''}`,
    );
  }

  // Leads que os deploys apagaram, reconstruidos a partir dos logs. E
  // idempotente: passado o primeiro arranque, isto so confirma o que ja la
  // esta e nao mexe em nada.
  if (env.RECOVER_LEADS) {
    const { criados, existentes } = await restoreLeads(LEADS_RECUPERADOS);
    if (criados > 0) {
      log.info(`recuperacao: ${criados} lead(s) repostos dos logs (${existentes} ja existiam)`);
    }
  }

  // Os leads recuperados dos logs vieram so com o chat_id e apareciam na caixa
  // de entrada como "#8962954467". O Telegram sabe o nome de quem ja falou com
  // o bot: isto vai busca-lo, em fundo para nao atrasar o arranque.
  void preencherNomes(bot.api).catch((error: unknown) => {
    log.warn('falha a preencher nomes dos leads', error);
  });

  // Backup periodico para o canal. Enquanto nao houver disco persistente, e o
  // que fica entre um deploy e perder tudo outra vez.
  if (env.BACKUP_ENABLED) {
    const intervalo = env.BACKUP_INTERVAL_MINUTES * 60 * 1000;
    backupTimer = setInterval(() => void backupDatabase(bot.api), intervalo);
    backupTimer.unref();
    log.info(`backup para o canal a cada ${env.BACKUP_INTERVAL_MINUTES} min`);
    void backupDatabase(bot.api);
  }

  if (env.modeSource === 'forcado-em-producao') {
    log.warn(
      'TELEGRAM_MODE pedia polling, mas em producao com URL publica o webhook e imposto ' +
        '— em polling o servico fica mudo apos hibernar. Remova a variavel para silenciar este aviso.',
    );
  }

  if (env.missingPublicUrlInProduction) {
    // Producao sem URL publica: o bot nao vai receber nada. Melhor gritar aqui
    // e no /health do que deixar o servico "no ar" e mudo.
    telegram.error =
      'producao sem URL publica: defina TELEGRAM_WEBHOOK_URL com a URL https:// do servico ' +
      '(o Render normalmente injeta RENDER_EXTERNAL_URL sozinho)';
    log.error(telegram.error);
  }

  try {
    await bot.init();
    telegram.botUsername = bot.botInfo.username;
    log.info(`bot @${bot.botInfo.username} inicializado (${env.NODE_ENV})`);

    await bot.api.setMyCommands(BOT_COMMANDS);

    if (env.TELEGRAM_MODE === 'webhook') {
      await startWebhook();
    } else {
      await startPolling();
    }

    // So depois de o bot estar ligado: o agendador envia pela API do Telegram.
    startRemarketingScheduler();
  } catch (error) {
    // O processo continua de pe: o /health passa a responder "degraded" com o
    // motivo, o que e mais diagnosticavel do que um container reiniciando.
    telegram.error = error instanceof Error ? error.message : String(error);
    log.error('falha ao conectar no Telegram; servidor segue no ar', error);
  }
}

async function startWebhook(): Promise<void> {
  const url = `${env.TELEGRAM_WEBHOOK_URL}${env.webhookPath}`;


  await bot.api.setWebhook(url, {
    secret_token: env.TELEGRAM_WEBHOOK_SECRET,
    drop_pending_updates: !isProduction,
    allowed_updates: ['message'],
  });

  log.info(`webhook registrado em ${url}`);

  // Confirma com o proprio Telegram em vez de assumir que o setWebhook
  // resolveu: getWebhookInfo devolve a URL que ele realmente tem, quantos
  // updates estao represados e o ultimo erro de entrega — que e onde aparece
  // um "Wrong response from the webhook" ou um certificado invalido.
  const info = await bot.api.getWebhookInfo();

  telegram.webhookRegistered = info.url === url;
  telegram.pendingUpdates = info.pending_update_count;
  telegram.lastError = info.last_error_message ?? null;

  if (!telegram.webhookRegistered) {
    log.warn(`o Telegram registrou "${info.url}" em vez de "${url}"`);
  }

  if (info.last_error_message) {
    log.warn(`ultima falha de entrega do Telegram: ${info.last_error_message}`);
  }

  if (info.pending_update_count > 0) {
    log.info(`${info.pending_update_count} updates represados serao entregues agora`);
  }
}

async function startPolling(): Promise<void> {
  // Em polling o Telegram recusa updates se um webhook antigo continuar ativo.
  await bot.api.deleteWebhook({ drop_pending_updates: true });

  void bot.start({
    allowed_updates: ['message'],
    onStart: (info) => log.info(`long polling ativo para @${info.username}`),
  });
}

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`recebido ${signal}, encerrando...`);

  const timeout = setTimeout(() => {
    log.warn('shutdown demorou demais, forcando saida');
    process.exit(1);
  }, 10_000);

  timeout.unref();

  try {
    stopRemarketingScheduler();

    if (env.TELEGRAM_MODE === 'polling') {
      await bot.stop();
    }

    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });

    // Ultimo backup antes de fechar: o encerramento de um deploy e
    // exactamente o momento em que a base de dados esta prestes a desaparecer.
    if (backupTimer) clearInterval(backupTimer);
    if (env.BACKUP_ENABLED) await backupDatabase(bot.api);

    await closeDatabase();
    log.info('encerrado com sucesso');
    process.exit(0);
  } catch (error) {
    log.error('falha durante o shutdown', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('promise rejeitada sem tratamento', reason);
});

process.on('uncaughtException', (error) => {
  log.error('excecao nao capturada', error);
  void shutdown('uncaughtException');
});

start().catch((error) => {
  log.error('falha ao iniciar a aplicacao', error);
  process.exit(1);
});
