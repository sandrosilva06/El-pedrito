/**
 * Bom dia, boa tarde, boa noite — pela hora da Suica.
 *
 * Calculado em codigo e nao pedido ao modelo, por uma razao simples: um modelo
 * de linguagem NAO TEM RELOGIO. Nao sabe que horas sao, e se lhe pedirem para
 * cumprimentar conforme a hora ele inventa — e um "bom dia" as onze da noite
 * denuncia a automacao mais depressa do que qualquer erro de portugues.
 *
 * O fuso e o da Suica e nao o do servidor: o Render corre em UTC, e no Verao
 * sao duas horas de diferenca. Um lead em Zurique a receber "boa tarde" as
 * 21h30 e exactamente o tipo de pormenor que faz uma pessoa desconfiar sem
 * saber bem porque.
 */

/**
 * Os limites:
 *   00:00–05:59  Boa noite
 *   06:00–11:59  Bom dia
 *   12:00–19:59  Boa tarde
 *   20:00–23:59  Boa noite
 *
 * A madrugada fica com "Boa noite" e nao com "Bom dia", apesar de ser tecnicamente
 * de manha: um lead que escreve a uma da manha e ouve "Bom dia" percebe logo que
 * do outro lado ninguem esta a olhar para o relogio. Foi visto a acontecer.
 */
export function saudacaoPara(horaSuica: number): string {
  if (horaSuica < 6) return 'Boa noite';
  if (horaSuica < 12) return 'Bom dia';
  if (horaSuica < 20) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * A hora que sao na Suica agora.
 *
 * Usa o Intl em vez de contas com offsets: a mudanca da hora de Verao acontece
 * em datas diferentes todos os anos, e uma conta a mao fica errada durante
 * umas semanas por ano sem ninguem dar por isso.
 */
export function horaNaSuica(agora: Date = new Date()): number {
  const texto = new Intl.DateTimeFormat('pt-PT', {
    timeZone: 'Europe/Zurich',
    hour: '2-digit',
    hour12: false,
  }).format(agora);

  return Number(texto.replace(/\D/g, ''));
}

/** O cumprimento a usar neste momento. */
export function saudacaoAgora(agora: Date = new Date()): string {
  return saudacaoPara(horaNaSuica(agora));
}
