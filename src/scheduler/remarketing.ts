import { env } from '../config/env';
import {
  claimRemarketingSlot,
  clearDepositPromise,
  getDuePromises,
  getRemarketingTargets,
  markBlocked,
  markRemarketed,
  recordRemarketingSent,
  type Lead,
  type RemarketingAudience,
} from '../db/database';
import {
  NAO_CONVERTIDO_TOUCHES,
  generateRemarketingMessage,
  personalise,
} from '../services/remarketing';
import { createLogger } from '../utils/logger';
import { nowInTimezone } from '../utils/timezone';
import { bot } from '../telegram/bot';

const log = createLogger('agendador');

const AUDIENCES: RemarketingAudience[] = ['nao_convertido', 'vip'];

/** Tecto por slot: uma campanha nao deve inundar a API do Telegram de uma vez. */
const BATCH_LIMIT = 200;

/** Pausa entre envios, para nao atirar a campanha toda de uma vez ao Telegram. */
const SEND_INTERVAL_MS = env.REMARKETING_SEND_INTERVAL_MS;

/**
 * Tecto de toques a quem nao converteu. Fica travado no numero de guioes
 * escritos: um toque a mais sairia sem texto proprio, e a variavel de ambiente
 * pode estar posta num valor antigo num deploy que ja esta a correr.
 */
const MAX_TOUCHES = Math.min(env.REMARKETING_MAX_TOUCHES, NAO_CONVERTIDO_TOUCHES.length);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSlots(): string[] {
  return env.REMARKETING_SLOTS.split(',')
    .map((slot) => slot.trim())
    .filter((slot) => /^\d{2}:\d{2}$/.test(slot));
}

/**
 * Um slot esta "a vencer" quando a hora atual ja o passou, no mesmo dia. Nao
 * se exige a coincidencia exata do minuto: se o servico esteve a dormir a
 * essa hora — o que acontece em plano gratuito — o envio sai no primeiro
 * despertar em vez de se perder o dia.
 */
function dueSlot(time: string, slots: string[]): string | null {
  const due = slots.filter((slot) => slot <= time).sort();
  return due[due.length - 1] ?? null;
}

async function sendToAudience(
  audience: RemarketingAudience,
  slot: string,
  date: string,
): Promise<void> {
  // A reserva e por (slot, dia, publico) e vive na base de dados: o Render
  // reinicia o servico a toda a hora, e sem isto cada reinicio dentro da
  // janela reenviaria a campanha inteira.
  if (!claimRemarketingSlot(slot, date, audience)) return;

  // O VIP e uma lista so; quem nao converteu corre toque a toque, porque cada
  // toque tem o seu texto e a sua janela de tempo.
  const touches = audience === 'vip' ? [0] : [...Array(MAX_TOUCHES).keys()];

  let sent = 0;
  let considered = 0;

  for (const touch of touches) {
    const targets = getRemarketingTargets({
      audience,
      touch,
      // Primeiro toque: conta desde a ultima coisa que o lead disse. Segundo:
      // continua a exigir o mesmo silencio, mais o intervalo desde o toque 1.
      coldHours: env.REMARKETING_FIRST_TOUCH_HOURS,
      sinceLastTouchHours:
        audience === 'vip'
          ? env.REMARKETING_QUIET_HOURS
          : touch === 0
            ? env.REMARKETING_FIRST_TOUCH_HOURS
            : env.REMARKETING_SECOND_TOUCH_HOURS,
      limit: BATCH_LIMIT,
    });

    if (targets.length === 0) continue;

    considered += targets.length;

    const { template, generated } = await generateRemarketingMessage(audience, touch);
    log.info(
      `slot ${slot} (${audience}, toque ${touch + 1}): ${targets.length} leads, ` +
        `mensagem ${generated ? 'gerada' : 'de reserva'}`,
    );

    for (const lead of targets) {
      const delivered = await sendOne(lead, template);
      if (delivered) sent += 1;

      // A pausa fica DENTRO da fila e nao entre toques: e o ritmo de entrega
      // ao Telegram que interessa, nao a fronteira entre as duas listas.
      await sleep(SEND_INTERVAL_MS);
    }
  }

  if (considered === 0) {
    log.info(`slot ${slot} (${audience}): nenhum lead elegivel`);
    return;
  }

  recordRemarketingSent(slot, date, audience, sent);
  log.info(`slot ${slot} (${audience}): ${sent}/${considered} entregues`);
}

async function sendOne(lead: Lead, template: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(lead.chatId, personalise(template, lead.firstName), {
      link_preview_options: { is_disabled: true },
    });

    markRemarketed(lead.chatId);
    return true;
  } catch (error) {
    const description = (error as { description?: string })?.description ?? '';

    // 403 significa que o lead bloqueou o bot ou apagou a conversa. Insistir
    // com quem bloqueou nao entrega nada e conta para os limites do Telegram.
    if (/bot was blocked|user is deactivated|chat not found/i.test(description)) {
      markBlocked(lead.chatId);
      log.info(`lead ${lead.chatId} bloqueou o bot; retirado da lista`);
      return false;
    }

    log.warn(`falha ao enviar remarketing a ${lead.chatId}`, description || error);
    return false;
  }
}

/**
 * Lembretes individuais de promessa de deposito. Corre a cada minuto, nao nos
 * slots: a hora foi combinada com cada lead e um slot fixo chegaria horas ao
 * lado do que ficou prometido.
 *
 * Ao contrario do remarketing em massa, este lembrete ignora as horas de
 * silencio — o lead pediu-o ("apitas-me aqui"), e o silencio existe para nao
 * incomodar quem nao pediu nada.
 */
async function sendDuePromises(): Promise<void> {
  const due = getDuePromises(new Date().toISOString(), 100);
  if (due.length === 0) return;

  const { template, generated } = await generateRemarketingMessage('promessa');
  log.info(`${due.length} promessa(s) vencida(s), mensagem ${generated ? 'gerada' : 'de reserva'}`);

  for (const lead of due) {
    // Limpa antes de enviar: se o envio falhar, o lead nao fica a receber o
    // mesmo lembrete a cada minuto ate ao fim dos tempos.
    clearDepositPromise(lead.chatId);

    const delivered = await sendOne(lead, template);
    log.info(
      `lembrete de promessa chat=${lead.chatId} (${lead.promiseNote ?? '?'}) ` +
        `${delivered ? 'entregue' : 'falhou'}`,
    );

    await sleep(SEND_INTERVAL_MS);
  }
}

async function tick(): Promise<void> {
  try {
    await sendDuePromises();
  } catch (error) {
    log.error('falha ao enviar lembretes de promessa', error);
  }

  const slots = parseSlots();
  if (slots.length === 0) return;

  const { time, date } = nowInTimezone(env.REMARKETING_TIMEZONE);
  const slot = dueSlot(time, slots);
  if (!slot) return;

  for (const audience of AUDIENCES) {
    try {
      await sendToAudience(audience, slot, date);
    } catch (error) {
      log.error(`falha no slot ${slot} (${audience})`, error);
    }
  }
}

let timer: NodeJS.Timeout | null = null;

export function startRemarketingScheduler(): void {
  if (!env.REMARKETING_ENABLED) {
    log.info('remarketing desligado (REMARKETING_ENABLED=false)');
    return;
  }

  const slots = parseSlots();

  if (slots.length === 0) {
    log.warn(`REMARKETING_SLOTS invalido: "${env.REMARKETING_SLOTS}". Agendador parado.`);
    return;
  }

  log.info(
    `remarketing activo — slots ${slots.join(', ')} (${env.REMARKETING_TIMEZONE}), ` +
      `${MAX_TOUCHES} toque(s) por lead que nao converteu ` +
      `(1.o as ${env.REMARKETING_FIRST_TOUCH_HOURS}h de silencio, ` +
      `2.o ${env.REMARKETING_SECOND_TOUCH_HOURS}h depois), ` +
      `${SEND_INTERVAL_MS}ms entre envios, ` +
      'lembretes de promessa a cada minuto',
  );

  void tick();
  timer = setInterval(() => void tick(), 60_000);
}

export function stopRemarketingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
