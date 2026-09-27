/**
 * Quem esta a falar, escolhido por quem sabe: o transporte.
 *
 * NAO ha aqui uma "persona activa". Isso era o desenho antigo, de quando cada
 * influencer corria no seu proprio servico e uma variavel de ambiente decidia
 * qual — e num processo com os dois ao mesmo tempo uma variavel dessas e
 * exactamente o bug que nao pode acontecer.
 *
 * Um identificador de persona so pode vir de quatro sitios, e a lista e curta de
 * proposito:
 *   1. o literal 'el_pedrito' no bot e na conta do El Pedrito
 *   2. o literal 'ivan' no bot do Ivan
 *   3. a coluna `persona` de um lead que ja existe
 *   4. o `?persona=` do painel, depois de validado
 */
import { elPedrito } from './el-pedrito';
import { ivan } from './ivan';
import { IDS_PERSONA, type IdPersona } from './ids';
import type { Persona } from './types';

const REGISTO: Record<IdPersona, Persona> = {
  el_pedrito: elPedrito,
  ivan,
};

/**
 * A persona com este id.
 *
 * Lanca em vez de recuar para uma qualquer: responder com o influencer errado e
 * pior do que nao responder, e um recuo silencioso aqui era a mistura a
 * acontecer sem ninguem dar por ela.
 */
export function personaDe(id: IdPersona): Persona {
  return REGISTO[id];
}

/** Todos os influencers que o codigo conhece. */
export function todasAsPersonas(): Persona[] {
  return IDS_PERSONA.map((id) => REGISTO[id]);
}
