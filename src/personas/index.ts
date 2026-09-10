import { env } from '../config/env';
import { createLogger } from '../utils/logger';
import { elPedrito } from './el-pedrito';
import { ivan } from './ivan';
import type { Persona } from './types';

const log = createLogger('persona');

const PERSONAS: Record<string, Persona> = {
  [elPedrito.id]: elPedrito,
  [ivan.id]: ivan,
};

/**
 * Persona activa, escolhida por BOT_PERSONA. O default e o El Pedrito porque
 * e o que ja esta em producao: uma variavel em falta nao pode trocar de
 * influencer a meio de conversas a decorrer.
 */
export const persona: Persona = (() => {
  const chosen = PERSONAS[env.BOT_PERSONA];

  if (!chosen) {
    log.error(
      `BOT_PERSONA="${env.BOT_PERSONA}" nao existe. Disponiveis: ` +
        `${Object.keys(PERSONAS).join(', ')}. A usar "${elPedrito.id}".`,
    );
    return elPedrito;
  }

  log.info(`persona activa: ${chosen.id} (${chosen.agentName})`);
  return chosen;
})();

export { resolveHouseLink } from './types';
export type { Persona, PersonaHouse } from './types';
