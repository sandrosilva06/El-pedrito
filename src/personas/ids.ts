/**
 * Quem sao os influencers, e nada mais do que isso.
 *
 * Fica num ficheiro proprio, separado dos prompts e da configuracao de cada
 * um, por uma razao pratica: a camada de dados precisa de saber que personas
 * EXISTEM para as guardar e filtrar, mas nao pode passar a importar 600 linhas
 * de prompt para isso. Um identificador nao arrasta um influencer atras dele.
 */

/** Os influencers que o codigo conhece. */
export const IDS_PERSONA = ['el_pedrito', 'ivan'] as const;

export type IdPersona = (typeof IDS_PERSONA)[number];

/**
 * A persona de quem ja estava na base de dados antes de haver duas.
 *
 * Usada so como valor por omissao de colunas e em dados historicos
 * (VIP_CHAT_IDS, leads recuperados dos logs), porque e a verdade: quando
 * aqueles leads foram criados havia um influencer so.
 */
export const PERSONA_HISTORICA: IdPersona = 'el_pedrito';

/**
 * E este texto o id de uma persona?
 *
 * Existe para validar o que vem de fora — o `?persona=` do painel, uma coluna
 * lida da base de dados — em vez de confiar numa conversao de tipo. Um valor
 * desconhecido tem de ser recusado e nao adivinhado.
 */
export function ehIdPersona(valor: unknown): valor is IdPersona {
  return typeof valor === 'string' && (IDS_PERSONA as readonly string[]).includes(valor);
}
