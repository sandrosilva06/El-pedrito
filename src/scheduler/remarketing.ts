import { env } from '../config/env';
import {
  claimRemarketingSlot,
  getRemarketingTargets,
  markBlocked,
  markRemarketed,
  recordRemarketingSent,
  type Lead,
  type RemarketingAudience,
} from '../db/database';
import { generateRemarketingMessage, personalise } from '../services/remarketing';
import { createLogger } from '../utils/logger';
import { bot } from '../telegram/bot';

const log = createLogger('agendador');

const AUDIENCES: RemarketingAudience[] = ['nao_convertido', 'vip'];

/** Tecto por slot: uma campanha nao deve inundar a API do Telegram de uma vez. */
const BATCH_LIMIT = 200;

/** O Telegram limita a ~30 mensagens por segundo; 120ms deixa margem. */
const SEND_INTERVAL_MS = 120;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hora e data no fuso dos leads, nao no do servidor. O Render corre em UTC e
 * a Suica muda para horario de verao — um slot fixo em UTC chegaria uma hora
 * ao lado durante metade do ano.
 */
function nowInLeadTimezone(): { time: string; date: string } {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: env.REMARKETING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  // O locale sueco formata como "2026-09-10 14:30", que ja e ISO-like.
  const [date, time] = formatter.format(new Date()).split(' ');
  return { date: date ?? '', time: time ?? '' };
}

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

  const targets = getRemarketingTargets({
    audience,
    maxTouches: env.REMARKETING_MAX_TOUCHES,
    quietHours: env.REMARKETING_QUIET_HOURS,
    limit: BATCH_LIMIT,
  });

  if (targets.length === 0) {
    log.info(`slot ${slot} (${audience}): nenhum lead elegivel`);
    return;
  }

  const { template, generated } = await generateRemarketingMessage(audience);
  log.info(
    `slot ${slot} (${audience}): ${targets.length} leads, mensagem ${generated ? 'gerada' : 'de reserva'}`,
  );

  let sent = 0;

  for (const lead of targets) {
    const delivered = await sendOne(lead, template);
    if (delivered) sent += 1;
    await sleep(SEND_INTERVAL_MS);
  }

  recordRemarketingSent(slot, date, audience, sent);
  log.info(`slot ${slot} (${audience}): ${sent}/${targets.length} entregues`);
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

async function tick(): Promise<void> {
  const slots = parseSlots();
  if (slots.length === 0) return;

  const { time, date } = nowInLeadTimezone();
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
      `tecto de ${env.REMARKETING_MAX_TOUCHES} lembretes por lead`,
  );

  void tick();
  timer = setInterval(() => void tick(), 60_000);
}

export function stopRemarketingScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
