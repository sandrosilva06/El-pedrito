/**
 * Barramento de eventos do funil.
 *
 * A caixa de entrada recarregava a lista de X em X segundos. Funciona, mas o
 * operador so via a mensagem do lead no ciclo seguinte, e um lead novo so
 * aparecia depois de um F5 — numa conversa a serio, esses segundos sao a
 * diferenca entre responder a tempo e perder a pessoa.
 *
 * Isto e o meio do caminho entre a base de dados e a web: a camada de dados
 * anuncia o que aconteceu, a web traduz para o browser. A alternativa era
 * chamar o emissor em cada sitio que grava uma mensagem — e bastava esquecer
 * um para o ecra ficar desactualizado sem ninguem perceber porque.
 *
 * Nao ha dependencia nova: um EventEmitter do Node chega, e o transporte para
 * o browser e Server-Sent Events, que passa em qualquer proxy que ja sirva
 * HTTP. O socket.io traria um servidor, um cliente e um protocolo proprio para
 * fazer exactamente isto num sentido so.
 */
import { EventEmitter } from 'node:events';

export interface EventoMensagem {
  chatId: number;
  /** Do lado do lead ou do nosso. */
  role: 'user' | 'assistant';
  /** Quem a compos: a IA, o operador, ou o sistema. */
  author: 'bot' | 'humano' | 'sistema';
  content: string;
  mediaFileId: string | null;
  /** "photo" ou "video": decide a etiqueta com que a bolha e desenhada. */
  mediaKind: string | null;
  createdAt: string;
  /** Nota interna para a IA: nao e conversa e nao se mostra. */
  interna: boolean;
}

export interface EventoLead {
  chatId: number;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  stage: string;
}

interface Eventos {
  mensagem: [EventoMensagem];
  'lead-novo': [EventoLead];
  'lead-mudou': [EventoLead];
}

class BarramentoTipado extends EventEmitter {
  emitir<K extends keyof Eventos>(evento: K, ...args: Eventos[K]): void {
    this.emit(evento, ...args);
  }

  ao<K extends keyof Eventos>(evento: K, ouvinte: (...args: Eventos[K]) => void): () => void {
    this.on(evento, ouvinte as (...args: unknown[]) => void);
    return () => this.off(evento, ouvinte as (...args: unknown[]) => void);
  }
}

/**
 * Um so barramento para o processo inteiro.
 *
 * O limite de ouvintes sobe porque cada separador aberto da caixa de entrada e
 * um ouvinte, e o aviso dos 10 do Node nao se aplica aqui.
 */
export const eventos = new BarramentoTipado();
eventos.setMaxListeners(50);

/**
 * Uma mensagem e nota interna quando vem do lado do lead sem ele a ter
 * escrito: e o marcador que o funil grava para a IA saber o que aconteceu.
 * As que trazem imagem sao excepcao, porque a imagem e mesmo dele.
 */
export function ehNotaInterna(m: {
  role: string;
  author: string | null;
  mediaFileId: string | null;
}): boolean {
  return m.role === 'user' && m.author === 'sistema' && !m.mediaFileId;
}
