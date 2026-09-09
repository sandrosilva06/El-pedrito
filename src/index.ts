import http from 'node:http';

import express from 'express';
import { webhookCallback } from 'grammy';

import { env, isProduction } from './config/env';
import { closeDatabase, getStats } from './db/database';
import { BOT_COMMANDS, bot } from './telegram/bot';
import { createLogger } from './utils/logger';

const log = createLogger('server');

const app = express();

app.disable('x-powered-by');

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    mode: env.TELEGRAM_MODE,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

app.get('/stats', (req, res) => {
  // Endpoint interno: so responde com o segredo do webhook, para nao expor
  // metricas do funil publicamente.
  const provided = req.get('x-admin-token');

  if (!env.TELEGRAM_WEBHOOK_SECRET || provided !== env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  res.json(getStats());
});

if (env.TELEGRAM_MODE === 'webhook') {
  // O parser de JSON fica restrito a rota do webhook: o payload do Telegram e
  // pequeno e nenhuma outra rota recebe corpo.
  app.post(
    env.webhookPath,
    express.json({ limit: '1mb' }),
    webhookCallback(bot, 'express', {
      secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      timeoutMilliseconds: 60_000,
    }),
  );
}

app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

let server: http.Server | null = null;

async function start(): Promise<void> {
  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS);

  log.info(`bot @${bot.botInfo.username} inicializado (${env.NODE_ENV})`);

  server = app.listen(env.PORT, () => {
    log.info(`HTTP ouvindo na porta ${env.PORT}`);
  });

  if (env.TELEGRAM_MODE === 'webhook') {
    const url = `${env.TELEGRAM_WEBHOOK_URL}${env.webhookPath}`;

    await bot.api.setWebhook(url, {
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      drop_pending_updates: !isProduction,
      allowed_updates: ['message'],
    });

    log.info(`webhook registrado em ${url}`);
  } else {
    // Em polling o Telegram recusa updates se um webhook antigo continuar ativo.
    await bot.api.deleteWebhook({ drop_pending_updates: true });

    void bot.start({
      allowed_updates: ['message'],
      onStart: (info) => log.info(`long polling ativo para @${info.username}`),
    });
  }
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
    if (env.TELEGRAM_MODE === 'polling') {
      await bot.stop();
    }

    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
    });

    closeDatabase();
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
