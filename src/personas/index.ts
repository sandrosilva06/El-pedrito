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
import { IDS_PERSONA, type IdPersona } from './ids';
import type { Persona } from './types';

const REGISTO: Record<IdPersona, Persona | null> = {
  el_pedrito: elPedrito,
  // O Ivan entra aqui quando a persona dele for portada. Null e nao ausente
  // para o compilador continuar a exigir uma entrada por cada id conhecido.
  ivan: null,
};

/**
 * A persona com este id.
 *
 * Lanca em vez de recuar para uma qualquer: responder com o influencer errado e
 * pior do que nao responder, e um recuo silencioso aqui era a mistura a
 * acontecer sem ninguem dar por ela.
 */
export function personaDe(id: IdPersona): Persona {
  const persona = REGISTO[id];

  if (!persona) {
    throw new Error(`persona "${id}" pedida mas ainda nao existe no codigo`);
  }

  return persona;
}

/** Os influencers que ja estao implementados. */
export function personasImplementadas(): Persona[] {
  return IDS_PERSONA.map((id) => REGISTO[id]).filter((p): p is Persona => p !== null);
}
