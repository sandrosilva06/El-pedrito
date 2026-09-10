/**
 * Conversoes entre a hora local dos leads e UTC. O servidor corre em UTC e os
 * leads estao na Suica, que muda para horario de verao — tratar as duas como
 * a mesma coisa poe os lembretes uma hora ao lado durante metade do ano.
 */

/** Formata um instante como "YYYY-MM-DD HH:MM" no fuso pedido. */
function formatInTimezone(date: Date, timeZone: string): string {
  // O locale sueco ja produz o formato ISO-like, o que evita ter de remontar
  // os campos a mao.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function nowInTimezone(timeZone: string): { date: string; time: string } {
  const [date, time] = formatInTimezone(new Date(), timeZone).split(' ');
  return { date: date ?? '', time: time ?? '' };
}

/**
 * Converte uma hora de parede ("2026-09-10", "18:00") no fuso indicado para o
 * instante UTC correspondente.
 *
 * O Date do Node nao sabe construir uma data num fuso arbitrario, entao usa-se
 * a volta habitual: interpreta-se como UTC, ve-se que horas isso da no fuso
 * alvo, e corrige-se pela diferenca.
 */
function wallTimeToUtc(date: string, time: string, timeZone: string): Date {
  const asIfUtc = new Date(`${date}T${time}:00Z`);
  const seenInZone = formatInTimezone(asIfUtc, timeZone).replace(' ', 'T');
  const offset = asIfUtc.getTime() - new Date(`${seenInZone}:00Z`).getTime();

  return new Date(asIfUtc.getTime() + offset);
}

/**
 * Proxima ocorrencia de "HH:MM" no fuso dado, em ISO UTC. Se a hora de hoje ja
 * passou, devolve a de amanha: quem diz "as 18h" as 19h esta a falar do dia
 * seguinte, nao de ha uma hora.
 */
export function nextOccurrenceUtc(hhmm: string, timeZone: string): string {
  const { date, time } = nowInTimezone(timeZone);
  const target = wallTimeToUtc(date, hhmm, timeZone);

  if (hhmm > time) return target.toISOString();

  const tomorrow = new Date(`${date}T00:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDate = tomorrow.toISOString().slice(0, 10);

  return wallTimeToUtc(tomorrowDate, hhmm, timeZone).toISOString();
}
