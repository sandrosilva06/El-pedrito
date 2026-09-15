import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { GrammyError, InputFile } from 'grammy';

import { env } from '../config/env';
import {
  addMessage,
  getLead,
  getMessagesPage,
  listInboxLeads,
  markBlocked,
  setHumanHandover,
} from '../db/database';
import { bot, invalidateChat } from '../telegram/bot';
import { createLogger } from '../utils/logger';

const log = createLogger('inbox');

/** Uma sessao dura uma semana. Depois volta a pedir a palavra-passe. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'inbox_session';

/** O Telegram rejeita mensagens acima disto. */
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

/** Tecto do sendPhoto. A pagina ja reduz a imagem, isto e a rede de seguranca. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** A legenda de uma media tem menos folga do que uma mensagem de texto. */
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;

/**
 * Um file_id do Telegram e base64url. Validado antes de entrar num URL, para
 * nao haver maneira de o transformar noutro caminho da API.
 */
const FILE_ID_FORMAT = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Chave de assinatura das sessoes.
 *
 * Derivada da palavra-passe mais um valor aleatorio do arranque: mudar a
 * palavra-passe invalida as sessoes antigas, e um reinicio tambem. Para uma
 * caixa de uma pessoa so, isso e uma propriedade e nao um defeito.
 */
const sessionKey = createHmac('sha256', randomBytes(32))
  .update(env.ADMIN_PASSWORD ?? '')
  .digest();

function sign(value: string): string {
  return createHmac('sha256', sessionKey).update(value).digest('hex');
}

/** Comparacao em tempo constante, para o segredo nao se deixar adivinhar byte a byte. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  // O timingSafeEqual rebenta com comprimentos diferentes; compara-se o
  // comprimento primeiro, que nao e segredo.
  return left.length === right.length && timingSafeEqual(left, right);
}

function issueSession(): string {
  const expires = Date.now() + SESSION_TTL_MS;
  return `${expires}.${sign(String(expires))}`;
}

function sessionIsValid(token: string | undefined): boolean {
  if (!token) return false;

  const [expires, signature] = token.split('.');
  if (!expires || !signature) return false;
  if (!safeEqual(signature, sign(expires))) return false;

  return Number(expires) > Date.now();
}

/** Le um cookie sem dependencia externa; sao dois cookies no maximo. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }

  return undefined;
}

/**
 * Deixa passar o operador (cookie de sessao) ou o outro servico (segredo de
 * proxy). O segundo caso e o que permite ao servico que serve a pagina ler os
 * dados do bot vizinho sem o browser saber que existem dois sitios.
 *
 * Responde 404 e nao 401, pela mesma razao do /stats: quem nao tem credencial
 * nao fica a saber que a caixa existe.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (sessionIsValid(readCookie(req, COOKIE_NAME))) {
    next();
    return;
  }

  const offered = req.get('x-inbox-proxy');
  if (offered && env.INBOX_PROXY_SECRET && safeEqual(offered, env.INBOX_PROXY_SECRET)) {
    next();
    return;
  }

  res.status(404).json({ error: 'not found' });
}

function parseChatId(raw: string): number | null {
  const chatId = Number(raw);
  // Um id fora do inteiro seguro entregaria a mensagem a outra pessoa.
  return Number.isSafeInteger(chatId) ? chatId : null;
}

/**
 * Encaminha um pedido para o servico do outro bot.
 *
 * O proxy corre no servidor: o browser fala sempre com uma origem so, o que
 * dispensa CORS, um segundo login e ter o segredo do outro servico no
 * telemovel.
 */
async function proxyToIvan(req: Request, res: Response): Promise<void> {
  if (!env.IVAN_INBOX_URL || !env.INBOX_PROXY_SECRET) {
    res.status(503).json({ error: 'o segundo bot nao esta configurado' });
    return;
  }

  const target = `${env.IVAN_INBOX_URL.replace(/\/+$/, '')}/api${req.url}`;

  // Imagens nao cabem em JSON. A subida leva os bytes tal como chegaram, e a
  // descida devolve o que vier: sem isto o /ivan seria texto e mais nada.
  const enviaBytes = Buffer.isBuffer(req.body) && req.body.length > 0;
  const semCorpo = req.method === 'GET' || req.method === 'HEAD';

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: {
        'content-type': enviaBytes
          ? (req.get('content-type') ?? 'application/octet-stream')
          : 'application/json',
        'x-inbox-proxy': env.INBOX_PROXY_SECRET,
      },
      body: semCorpo ? undefined : enviaBytes ? new Uint8Array(req.body) : JSON.stringify(req.body),
      // O plano gratuito do Render hiberna: o primeiro pedido pode levar
      // dezenas de segundos a acordar o servico.
      signal: AbortSignal.timeout(60_000),
    });

    const tipo = upstream.headers.get('content-type') ?? '';

    if (tipo.startsWith('application/json')) {
      res.status(upstream.status).json(await upstream.json());
      return;
    }

    // Tudo o resto sao bytes, tipicamente uma imagem vinda do /media do Ivan.
    res.status(upstream.status);
    res.setHeader('content-type', tipo || 'application/octet-stream');
    const cache = upstream.headers.get('cache-control');
    if (cache) res.setHeader('cache-control', cache);
    res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    log.error('falha ao falar com o servico do Ivan', error);
    res.status(502).json({ error: 'o outro bot nao respondeu' });
  }
}

export function createInboxRouter(): Router {
  const router = express.Router();

  router.use(express.json({ limit: '64kb' }));

  // --- Sessao --------------------------------------------------------------

  router.post('/login', (req, res) => {
    const offered = String((req.body as { password?: unknown })?.password ?? '');

    if (!env.ADMIN_PASSWORD || !safeEqual(offered, env.ADMIN_PASSWORD)) {
      log.warn('tentativa de entrada na caixa com palavra-passe errada');
      res.status(401).json({ error: 'palavra-passe errada' });
      return;
    }

    res.cookie(COOKIE_NAME, issueSession(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: req.protocol === 'https' || req.get('x-forwarded-proto') === 'https',
      maxAge: SESSION_TTL_MS,
      path: '/',
    });

    res.json({ ok: true });
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    res.json({ authenticated: sessionIsValid(readCookie(req, COOKIE_NAME)) });
  });

  // --- Daqui para baixo, so com credencial ---------------------------------

  router.use(requireAuth);

  /** Que bots a caixa conhece. O primeiro e sempre este servico. */
  router.get('/bots', (_req, res) => {
    const bots = [{ id: 'local', label: env.BOT_LABEL ?? env.AGENT_NAME, prefix: '' }];

    if (env.IVAN_INBOX_URL && env.INBOX_PROXY_SECRET) {
      bots.push({ id: 'ivan', label: 'Ivan Rodrigues', prefix: '/ivan' });
    }

    res.json({ bots });
  });

  router.get('/leads', (req, res) => {
    const { search, stage, limit, offset } = req.query as Record<string, string | undefined>;

    res.json(
      listInboxLeads({
        search,
        stage,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      }),
    );
  });

  router.get('/leads/:chatId', (req, res) => {
    const chatId = parseChatId(req.params.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chat_id invalido' });
      return;
    }

    const lead = getLead(chatId);
    if (!lead) {
      res.status(404).json({ error: 'lead nao encontrado' });
      return;
    }

    res.json({ lead });
  });

  router.get('/leads/:chatId/messages', (req, res) => {
    const chatId = parseChatId(req.params.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chat_id invalido' });
      return;
    }

    const { before, limit } = req.query as Record<string, string | undefined>;

    res.json({
      messages: getMessagesPage(chatId, {
        before: before ? Number(before) : undefined,
        limit: limit ? Number(limit) : undefined,
      }),
    });
  });

  /**
   * Responder a mao.
   *
   * Envia directo, sem o ritmo humano de 7 a 8 segundos por bolha: esse teatro
   * existe para a IA nao parecer uma maquina, e aqui quem escreve e mesmo uma
   * pessoa, que nao tem de esperar meio minuto para ver a sua propria mensagem
   * sair.
   */
  router.post('/leads/:chatId/reply', async (req, res) => {
    const chatId = parseChatId(req.params.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chat_id invalido' });
      return;
    }

    const text = String((req.body as { text?: unknown })?.text ?? '').trim();

    if (text.length === 0) {
      res.status(400).json({ error: 'mensagem vazia' });
      return;
    }

    if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      res.status(400).json({ error: `o Telegram so aceita ${TELEGRAM_MAX_MESSAGE_LENGTH} caracteres` });
      return;
    }

    try {
      const sent = await bot.api.sendMessage(chatId, text, {
        link_preview_options: { is_disabled: true },
      });

      addMessage({ chatId, role: 'assistant', content: text, author: 'humano' });

      // Quem escreve a mao fica com a conversa. Sem isto a IA respondia a
      // seguir e contradizia o que o operador acabou de dizer.
      setHumanHandover(chatId, true);
      invalidateChat(chatId);

      log.info(`resposta manual enviada ao chat ${chatId} (message_id ${sent.message_id})`);
      res.json({ ok: true, messageId: sent.message_id });
    } catch (error) {
      const description = error instanceof GrammyError ? error.description : String(error);

      if (/bot was blocked|user is deactivated|chat not found/i.test(description)) {
        markBlocked(chatId);
        log.info(`chat ${chatId} bloqueou o bot; marcado`);
        res.status(409).json({ error: 'este lead bloqueou o bot', blocked: true });
        return;
      }

      log.error(`falha a responder a mao ao chat ${chatId}`, description);
      res.status(502).json({ error: description });
    }
  });

  /**
   * Enviar uma imagem ao lead.
   *
   * Recebe os bytes crus e nao base64 dentro de JSON: poupa um terco do
   * tamanho e dispensa um parser de multipart, que obrigaria a uma dependencia
   * nova. O limite maior aplica-se so aqui; as outras rotas ficam nos 64kb.
   */
  router.post(
    '/leads/:chatId/image',
    express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
    async (req, res) => {
      const chatId = parseChatId(req.params.chatId);
      if (chatId === null) {
        res.status(400).json({ error: 'chat_id invalido' });
        return;
      }

      const bytes = req.body;

      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        res.status(400).json({ error: 'manda os bytes da imagem com content-type image/*' });
        return;
      }

      const caption = String((req.query.caption as string | undefined) ?? '').trim();

      if (caption.length > TELEGRAM_MAX_CAPTION_LENGTH) {
        res
          .status(400)
          .json({ error: `a legenda so aceita ${TELEGRAM_MAX_CAPTION_LENGTH} caracteres` });
        return;
      }

      try {
        const sent = await bot.api.sendPhoto(chatId, new InputFile(bytes, 'imagem.jpg'), {
          ...(caption ? { caption } : {}),
        });

        // O Telegram devolve varios tamanhos; o ultimo e o de maior resolucao,
        // que e o que vale a pena guardar para a conversa voltar a mostrar.
        const fileId = sent.photo?.[sent.photo.length - 1]?.file_id ?? null;

        addMessage({
          chatId,
          role: 'assistant',
          content: caption,
          author: 'humano',
          mediaFileId: fileId,
          mediaKind: 'photo',
        });

        setHumanHandover(chatId, true);
        invalidateChat(chatId);

        log.info(`imagem enviada a mao ao chat ${chatId} (${bytes.length} bytes)`);
        res.json({ ok: true, messageId: sent.message_id, fileId });
      } catch (error) {
        const description = error instanceof GrammyError ? error.description : String(error);

        if (/bot was blocked|user is deactivated|chat not found/i.test(description)) {
          markBlocked(chatId);
          log.info(`chat ${chatId} bloqueou o bot; marcado`);
          res.status(409).json({ error: 'este lead bloqueou o bot', blocked: true });
          return;
        }

        log.error(`falha a enviar imagem ao chat ${chatId}`, description);
        res.status(502).json({ error: description });
      }
    },
  );

  /**
   * Devolve os bytes de uma imagem do Telegram.
   *
   * Passa pelo servidor de proposito. O URL de ficheiro do Telegram leva o
   * token do bot no caminho: servido ao browser, o token ficava no historico,
   * nos logs de rede e em qualquer captura de ecra da consola.
   */
  router.get('/media/:fileId', async (req, res) => {
    const fileId = req.params.fileId;

    if (!FILE_ID_FORMAT.test(fileId)) {
      res.status(400).json({ error: 'file_id invalido' });
      return;
    }

    try {
      const file = await bot.api.getFile(fileId);
      if (!file.file_path) {
        res.status(404).json({ error: 'ficheiro sem caminho' });
        return;
      }

      const upstream = await fetch(
        `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`,
        { signal: AbortSignal.timeout(30_000) },
      );

      if (!upstream.ok) {
        res.status(502).json({ error: 'o Telegram nao devolveu o ficheiro' });
        return;
      }

      // O file_id e imutavel, portanto a imagem pode ficar em cache a vontade.
      res.setHeader('content-type', upstream.headers.get('content-type') ?? 'image/jpeg');
      res.setHeader('cache-control', 'private, max-age=604800, immutable');

      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
      const description = error instanceof GrammyError ? error.description : String(error);
      log.error(`falha a obter o ficheiro ${fileId}`, description);
      res.status(502).json({ error: 'nao foi possivel obter a imagem' });
    }
  });

  router.post('/leads/:chatId/handover', (req, res) => {
    const chatId = parseChatId(req.params.chatId);
    if (chatId === null) {
      res.status(400).json({ error: 'chat_id invalido' });
      return;
    }

    const enabled = Boolean((req.body as { enabled?: unknown })?.enabled);

    setHumanHandover(chatId, enabled);
    // Corta qualquer turno em voo, para a IA nao falar depois de o operador
    // ter assumido a conversa.
    if (enabled) invalidateChat(chatId);

    log.info(`chat ${chatId}: controlo manual ${enabled ? 'ligado' : 'desligado'}`);
    res.json({ ok: true, humanHandover: enabled });
  });

  // --- O outro bot ---------------------------------------------------------

  // O express.json do router so pega em application/json, portanto os bytes de
  // uma imagem chegariam aqui por ler. Este raw trata disso antes do proxy.
  router.all(
    '/ivan/*',
    express.raw({ type: 'image/*', limit: MAX_IMAGE_BYTES }),
    (req, res) => void proxyToIvan(req, res),
  );

  return router;
}
