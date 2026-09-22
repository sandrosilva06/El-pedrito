/**
 * A pagina da caixa de entrada, embutida como string.
 *
 * Fica num modulo TypeScript e nao num .html a parte porque o `tsc` nao copia
 * ficheiros que nao sejam codigo para o `dist/`: um .html solto funcionaria com
 * o `tsx` em desenvolvimento e desaparecia no build de producao.
 *
 * Sem framework e sem passo de compilacao. Sao tres ecras, e meter um bundler
 * no projecto para isto custaria mais a manter do que o que resolve.
 */
export const ADMIN_HTML = String.raw`<!doctype html>
<html lang="pt">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Caixa de entrada</title>
<style>
  :root {
    --fundo: #0f1216; --painel: #171c22; --linha: #232a33;
    --texto: #e6eaef; --fraco: #8e9aa8; --recebida: #1f262e;
    --enviada: #1c4532; --manual: #3a2f12; --auto: #2a2330;
    --accao: #2f81f7; --perigo: #d1434b;
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; background: var(--fundo); color: var(--texto);
    font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    overscroll-behavior-y: none;
  }
  button, input, textarea, select { font: inherit; color: inherit; }
  .ecra { display: none; }
  .ecra.activo { display: flex; flex-direction: column; min-height: 100dvh; }

  /* --- login --- */
  #login { justify-content: center; align-items: center; padding: 24px; gap: 14px; }
  #login h1 { font-size: 20px; margin: 0 0 4px; font-weight: 600; }
  #login p { color: var(--fraco); margin: 0 0 12px; font-size: 14px; }
  #login form { width: 100%; max-width: 320px; display: flex; flex-direction: column; gap: 10px; }

  input[type=password], input[type=search], textarea, select {
    background: var(--painel); border: 1px solid var(--linha);
    border-radius: 10px; padding: 11px 13px; width: 100%;
  }
  input:focus, textarea:focus, select:focus { outline: 2px solid var(--accao); outline-offset: -1px; }

  .botao {
    background: var(--accao); border: 0; border-radius: 10px; padding: 11px 16px;
    font-weight: 600; cursor: pointer; color: #fff;
  }
  .botao[disabled] { opacity: .5; cursor: default; }
  .botao.discreto { background: var(--painel); border: 1px solid var(--linha); color: var(--texto); }

  /* --- barra --- */
  .barra {
    position: sticky; top: 0; z-index: 5; background: var(--painel);
    border-bottom: 1px solid var(--linha); padding: 10px 12px;
    padding-top: max(10px, env(safe-area-inset-top));
    display: flex; gap: 8px; align-items: center;
  }
  .barra .titulo { font-weight: 600; flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .barra .sub { color: var(--fraco); font-size: 12px; font-weight: 400; }
  .icone {
    background: none; border: 0; color: var(--fraco); font-size: 22px;
    padding: 4px 8px; cursor: pointer; line-height: 1;
  }

  /* --- lista --- */
  #lista .filtros { padding: 10px 12px; display: flex; gap: 8px; }
  #lista .filtros select { width: auto; flex-shrink: 0; }
  .conversas { flex: 1; overflow-y: auto; }
  .conversa {
    display: flex; gap: 11px; padding: 12px; border-bottom: 1px solid var(--linha);
    cursor: pointer; align-items: flex-start;
  }
  .conversa:active { background: var(--painel); }
  .avatar {
    width: 38px; height: 38px; border-radius: 50%; background: var(--linha);
    display: grid; place-items: center; font-weight: 600; flex-shrink: 0; font-size: 15px;
  }
  .conversa .corpo { flex: 1; min-width: 0; }
  .conversa .nome { display: flex; gap: 6px; align-items: baseline; }
  .conversa .nome b { font-weight: 600; }
  .conversa .quando { color: var(--fraco); font-size: 12px; margin-left: auto; flex-shrink: 0; }
  .conversa .excerto {
    color: var(--fraco); font-size: 13px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; margin-top: 2px;
  }
  .etiqueta {
    font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    padding: 2px 6px; border-radius: 5px; background: var(--linha); color: var(--fraco);
  }
  .etiqueta.mao { background: var(--manual); color: #e8c86a; }
  .etiqueta.bloqueado { background: #3a1a1c; color: #e88; }
  .etiqueta.vip { background: #123524; color: #6fe0a0; }
  .etiqueta.afixado { background: #2b2540; color: #b9a6ff; }

  /* --- conversa --- */
  .mensagens { flex: 1; overflow-y: auto; padding: 12px; display: flex;
    flex-direction: column; gap: 8px; }
  .bolha { max-width: 82%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap;
    word-wrap: break-word; }
  .bolha.deles { background: var(--recebida); align-self: flex-start; border-bottom-left-radius: 4px; }
  .bolha.nossa { background: var(--enviada); align-self: flex-end; border-bottom-right-radius: 4px; }
  .bolha.nossa.humano { background: var(--manual); }
  .bolha.nossa.sistema { background: var(--auto); }
  .bolha .meta { font-size: 11px; color: var(--fraco); margin-top: 4px; display: flex; gap: 6px; }
  .marcador { align-self: center; font-size: 12px; color: var(--fraco); font-style: italic;
    text-align: center; max-width: 90%; }

  .compositor {
    border-top: 1px solid var(--linha); background: var(--painel); padding: 10px;
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    display: flex; gap: 8px; align-items: flex-end;
  }
  .compositor textarea { resize: none; max-height: 120px; }
  .compositor .anexo {
    background: none; border: 0; color: var(--fraco); font-size: 24px;
    padding: 6px 4px; cursor: pointer; line-height: 1; flex-shrink: 0;
  }

  .bolha img {
    display: block; max-width: 100%; border-radius: 10px; cursor: pointer;
    background: var(--linha); min-height: 60px;
  }
  .bolha .legenda { margin-top: 6px; }

  /* Pre-visualizacao antes de enviar */
  #previa {
    position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.92);
    display: none; flex-direction: column; padding: 16px;
    padding-bottom: max(16px, env(safe-area-inset-bottom));
    padding-top: max(16px, env(safe-area-inset-top)); gap: 12px;
  }
  #previa.activo { display: flex; }
  #previa .imagem { flex: 1; display: grid; place-items: center; min-height: 0; }
  #previa img { max-width: 100%; max-height: 100%; border-radius: 10px; object-fit: contain; }
  #previa .accoes { display: flex; gap: 8px; }
  #previa .accoes .botao { flex: 1; }

  /* Ver em grande */
  #lupa {
    position: fixed; inset: 0; z-index: 30; background: rgba(0,0,0,.95);
    display: none; place-items: center; padding: 12px;
  }
  #lupa.activo { display: grid; }
  #lupa img { max-width: 100%; max-height: 100%; object-fit: contain; }

  /* --- botoes de remarketing, lado a lado --- */
  .remk { display: flex; gap: 6px; }
  .remk button {
    border: 0; border-radius: 8px; padding: 7px 10px; font-size: 12px;
    font-weight: 600; cursor: pointer; white-space: nowrap; line-height: 1;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .remk button[disabled] { opacity: .6; cursor: default; }
  .remk .frio { background: #4a3410; color: #f0b429; }
  .remk .vip  { background: #2e2350; color: #b9a6ff; }

  /* O spinner ocupa o lugar do ponto, para o botao nao mudar de largura a
     meio do envio e saltar debaixo do dedo. */
  .girar {
    width: 11px; height: 11px; border-radius: 50%; flex-shrink: 0;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: roda .6s linear infinite;
  }
  @keyframes roda { to { transform: rotate(360deg); } }

  #toast {
    position: fixed; left: 50%; transform: translateX(-50%);
    bottom: calc(76px + env(safe-area-inset-bottom)); z-index: 40;
    background: #123524; color: #6fe0a0; border: 1px solid #1d5c3c;
    padding: 10px 16px; border-radius: 999px; font-size: 13px; font-weight: 600;
    opacity: 0; pointer-events: none; transition: opacity .18s;
    max-width: calc(100% - 32px); text-align: center;
  }
  #toast.activo { opacity: 1; }
  #toast.mau { background: #3a1a1c; color: #f2a0a4; border-color: #5c2226; }

  .aviso { padding: 10px 12px; font-size: 13px; text-align: center; }
  .aviso.mao { background: var(--manual); color: #e8c86a; }
  .aviso.erro { background: #3a1a1c; color: #f2a0a4; }
  .vazio { padding: 40px 20px; text-align: center; color: var(--fraco); }
</style>
</head>
<body>

<section id="login" class="ecra activo">
  <h1>Caixa de entrada</h1>
  <p>Conversas dos leads</p>
  <form id="form-login">
    <input type="password" id="palavra" placeholder="Palavra-passe" autocomplete="current-password" required>
    <button class="botao" type="submit">Entrar</button>
    <div id="erro-login" class="aviso erro" hidden></div>
  </form>
</section>

<section id="lista" class="ecra">
  <div class="barra">
    <div class="titulo">Conversas <span id="contagem" class="sub"></span></div>
    <button class="icone" id="sair" title="Sair">⎋</button>
  </div>
  <div class="filtros">
    <select id="bot"></select>
    <input type="search" id="procurar" placeholder="Procurar por nome">
  </div>
  <div class="conversas" id="conversas"></div>
</section>

<section id="conversa" class="ecra">
  <div class="barra">
    <button class="icone" id="voltar">‹</button>
    <div class="titulo">
      <div id="lead-nome"></div>
      <div class="sub" id="lead-info"></div>
    </div>
    <button class="icone" id="alternar-afixar" title="Afixar no topo">☆</button>
    <button class="botao discreto" id="alternar-vip">Aprovar</button>
    <button class="botao discreto" id="alternar-mao">Assumir</button>
  </div>
  <div class="barra" style="border-bottom:1px solid var(--linha);padding-top:8px;padding-bottom:8px;">
    <div class="sub" style="flex:1;min-width:0;">Remarketing</div>
    <div class="remk">
      <button class="frio" id="remk-frio" title="Para quem ainda não converteu">
        Não qualificado
      </button>
      <button class="vip" id="remk-vip" title="Para quem já está no grupo">
        Qualificado
      </button>
    </div>
  </div>
  <div id="aviso-mao" class="aviso mao" hidden>Estás a levar esta conversa. O bot não responde.</div>
  <div class="mensagens" id="mensagens"></div>
  <div class="compositor">
    <button class="anexo" id="anexar" title="Enviar imagem">📎</button>
    <input type="file" id="ficheiro" accept="image/*" hidden>
    <textarea id="texto" rows="1" placeholder="Escrever…"></textarea>
    <button class="botao" id="enviar">Enviar</button>
  </div>
</section>

<div id="toast"></div>

<div id="previa">
  <div class="imagem"><img id="previa-img" alt=""></div>
  <input type="text" id="previa-legenda" placeholder="Legenda (opcional)"
         style="background:var(--painel);border:1px solid var(--linha);border-radius:10px;padding:11px 13px;">
  <div class="accoes">
    <button class="botao discreto" id="previa-cancelar">Cancelar</button>
    <button class="botao" id="previa-enviar">Enviar imagem</button>
  </div>
</div>

<div id="lupa"><img id="lupa-img" alt=""></div>

<script>
const $ = (id) => document.getElementById(id);
let prefixo = '';           // '' para este bot, '/ivan' para o outro
let chatAberto = null;
let leadAberto = null;
let temporizador = null;

function mostrar(ecra) {
  for (const s of document.querySelectorAll('.ecra')) s.classList.toggle('activo', s.id === ecra);
}

async function api(caminho, opcoes = {}) {
  const r = await fetch('/api' + prefixo + caminho, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...opcoes,
  });
  if (r.status === 404 && !opcoes.silencioso) { mostrar('login'); throw new Error('sessao'); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || ('erro ' + r.status));
  return corpo;
}

function quando(iso) {
  if (!iso) return '';
  // O SQLite grava 'YYYY-MM-DD HH:MM:SS' em UTC, sem T nem Z.
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  const agora = new Date();
  const mesmoDia = d.toDateString() === agora.toDateString();
  return mesmoDia
    ? d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
}

/**
 * Nome a mostrar. Primeiro e apelido quando existem, senao o username, e só
 * em último caso o número — que é o que se via em todos os leads recuperados.
 */
function nomeDe(l) {
  const completo = [l.firstName, l.lastName].filter(Boolean).join(' ').trim();
  if (completo) return completo;
  if (l.username) return '@' + l.username;
  return '#' + l.chatId;
}

function iniciais(nome) {
  return (nome || '?').trim().slice(0, 1).toUpperCase() || '?';
}

// --- login ---
$('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('erro-login').hidden = true;
  try {
    const r = await fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('palavra').value }),
    });
    if (!r.ok) throw new Error('Palavra-passe errada');
    $('palavra').value = '';
    await arrancar();
  } catch (err) {
    $('erro-login').textContent = err.message;
    $('erro-login').hidden = false;
  }
});

$('sair').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  mostrar('login');
});

// --- lista ---
async function carregarBots() {
  const { bots } = await api('/bots');
  $('bot').innerHTML = bots.map((b) => '<option value="' + b.prefix + '">' + b.label + '</option>').join('');
  $('bot').hidden = bots.length < 2;
}

async function carregarLista() {
  const procura = encodeURIComponent($('procurar').value.trim());
  const { leads, total } = await api('/leads?limit=50&search=' + procura);

  $('contagem').textContent = total ? '(' + total + ')' : '';

  if (!leads.length) {
    $('conversas').innerHTML = '<div class="vazio">Sem conversas ainda.</div>';
    return;
  }

  $('conversas').innerHTML = leads.map((l) => {
    const nome = nomeDe(l);
    const etiquetas =
      (l.pinned ? '<span class="etiqueta afixado">★ afixado</span>' : '') +
      (l.stage === 'acesso_liberado' ? '<span class="etiqueta vip">VIP</span>' : '') +
      (l.humanHandover ? '<span class="etiqueta mao">à mão</span>' : '') +
      (l.blocked ? '<span class="etiqueta bloqueado">bloqueou</span>' : '') +
      '<span class="etiqueta">' + l.stage + '</span>';
    return (
      '<div class="conversa" data-chat="' + l.chatId + '">' +
        '<div class="avatar">' + iniciais(nome) + '</div>' +
        '<div class="corpo">' +
          '<div class="nome"><b>' + escapar(nome) + '</b>' + etiquetas +
            '<span class="quando">' + quando(l.lastAt || l.updatedAt) + '</span></div>' +
          '<div class="excerto">' + escapar(l.lastContent || 'sem mensagens') + '</div>' +
        '</div>' +
      '</div>'
    );
  }).join('');

  for (const el of document.querySelectorAll('.conversa')) {
    el.addEventListener('click', () => abrir(Number(el.dataset.chat)));
  }
}

function escapar(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

$('procurar').addEventListener('input', () => {
  clearTimeout($('procurar').t);
  $('procurar').t = setTimeout(carregarLista, 250);
});

$('bot').addEventListener('change', () => {
  prefixo = $('bot').value;
  carregarLista();
});

// --- conversa ---
async function abrir(chatId) {
  chatAberto = chatId;
  mostrar('conversa');
  $('mensagens').innerHTML = '<div class="vazio">A carregar…</div>';
  await actualizarConversa(true);
  agendar();
}

async function actualizarConversa(irAoFundo) {
  if (chatAberto === null) return;

  const [{ lead }, { messages }] = await Promise.all([
    api('/leads/' + chatAberto),
    api('/leads/' + chatAberto + '/messages?limit=200'),
  ]);

  leadAberto = lead;
  $('lead-nome').textContent = nomeDe(lead);
  $('lead-info').textContent =
    [lead.username ? '@' + lead.username : null, lead.stage, lead.canton, '#' + lead.chatId]
      .filter(Boolean).join(' · ');

  $('aviso-mao').hidden = !lead.humanHandover;
  $('alternar-mao').textContent = lead.humanHandover ? 'Devolver ao bot' : 'Assumir';
  $('alternar-afixar').textContent = lead.pinned ? '★' : '☆';
  $('alternar-afixar').title = lead.pinned ? 'Desafixar' : 'Afixar no topo';
  $('alternar-vip').textContent = lead.stage === 'acesso_liberado' ? 'Aprovado ✓' : 'Aprovar';

  const html = messages.map((m) => {
    // Notas internas para a IA: são gravadas do LADO DO LEAD (role 'user')
    // sem ele ter escrito nada. A mensagem do remarketing e a de boas-vindas
    // ao VIP também são 'sistema', mas foram mesmo enviadas e aparecem — o
    // critério é este e não o autor, senão desapareciam do ecrã.
    if (m.role === 'user' && m.author === 'sistema' && !m.mediaFileId) return '';

    // O "!m.mediaFileId" importa: uma mensagem COM ficheiro nunca e um
    // marcador, mesmo que a legenda dela venha entre parentesis retos. Sem
    // isto, uma imagem com uma legenda assim desaparecia da conversa e ficava
    // no lugar dela uma nota cinzenta.
    if (!m.mediaFileId && m.content.startsWith('[')) {
      return '<div class="marcador">' + escapar(m.content) + '</div>';
    }

    const nosso = m.role === 'assistant';
    const autor = nosso ? ({ humano: 'tu', sistema: 'automático' }[m.author] || 'bot') : '';

    // Uma linha guardada na base de dados pode ter chegado ao lead como varias
    // mensagens: o envio parte o texto pelas linhas em branco antes de o
    // entregar. Sem repetir essa divisao aqui, a app mostrava um bloco unico
    // onde o lead viu duas ou tres bolhas, e a conversa nao batia certo com a
    // que ele tem no telemovel.
    const partes = m.content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

    const classe = nosso ? 'nossa ' + m.author : 'deles';
    const meta = '<div class="meta"><span>' + quando(m.createdAt) + '</span>' +
      (autor ? '<span>' + autor + '</span>' : '') + '</div>';

    // Mensagem com imagem: mostra a imagem e a legenda por baixo, se houver.
    // O src aponta para o proxy do servidor, nunca para o Telegram: o URL de
    // ficheiro deles leva o token do bot no caminho.
    if (m.mediaFileId) {
      const legenda = partes.length
        ? '<div class="legenda">' + escapar(partes.join('\n\n')) + '</div>'
        : '';
      return (
        '<div class="bolha ' + classe + '">' +
          '<img loading="lazy" alt="imagem" src="/api' + prefixo + '/media/' +
            encodeURIComponent(m.mediaFileId) + '" onclick="ampliar(this.src)">' +
          legenda + meta +
        '</div>'
      );
    }

    return partes.map((parte, i) => {
      // A hora vai so na ultima, como o Telegram faz num grupo de mensagens.
      const metaAqui = i === partes.length - 1 ? meta : '';
      return '<div class="bolha ' + classe + '">' + escapar(parte) + metaAqui + '</div>';
    }).join('');
  }).join('');

  const fundo = $('mensagens');
  const estavaNoFundo = fundo.scrollHeight - fundo.scrollTop - fundo.clientHeight < 60;
  // Uma conversa recuperada só tem a nota interna, que não se mostra: sem isto
  // o ecrã ficava em branco e parecia avariado.
  const soNotas = messages.length > 0 && !html.trim();
  fundo.innerHTML =
    html ||
    (soNotas
      ? '<div class="vazio">Este lead já falou com o bot, mas o texto das mensagens ' +
        'anteriores perdeu-se num deploy antigo. O que ele escrever a partir de agora ' +
        'aparece aqui.</div>'
      : '<div class="vazio">Sem mensagens.</div>');
  if (irAoFundo || estavaNoFundo) fundo.scrollTop = fundo.scrollHeight;
}

$('voltar').addEventListener('click', () => {
  chatAberto = null;
  clearInterval(temporizador);
  mostrar('lista');
  carregarLista();
});

/**
 * Aviso curto no fundo do ecrã. Sem isto o operador carrega no botão e não
 * sabe se a mensagem saiu ou se falhou em silêncio.
 */
let toastTimer = null;

function toast(texto, mau) {
  const el = $('toast');
  el.textContent = texto;
  el.classList.toggle('mau', Boolean(mau));
  el.classList.add('activo');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('activo'), 2600);
}

/**
 * Dispara um dos dois remarketings.
 *
 * O botão fica desligado com um spinner até à confirmação: são mensagens
 * reais para pessoas reais, e dois toques distraídos mandavam duas.
 */
async function dispararRemarketing(botao, tipo) {
  if (chatAberto === null || botao.disabled) return;

  const original = botao.innerHTML;
  botao.disabled = true;
  botao.innerHTML = '<span class="girar"></span>' + original;

  try {
    // O api() já levanta erro quando a resposta não é 200, com a descrição
    // que veio do Telegram.
    await api('/leads/' + chatAberto + '/remarketing', {
      method: 'POST', body: JSON.stringify({ tipo }),
    });

    toast('Remarketing enviado com sucesso!');
    // A conversa actualiza-se sozinha pelo fluxo de eventos; isto é só para
    // o caso de a ligação em tempo real estar em baixo.
    await actualizarConversa(true);
  } catch (e) {
    toast('Não saiu: ' + (e.message || 'erro'), true);
  } finally {
    botao.disabled = false;
    botao.innerHTML = original;
  }
}

$('remk-frio').addEventListener('click', (e) => {
  void dispararRemarketing(e.currentTarget, 'nao_qualificado');
});

$('remk-vip').addEventListener('click', (e) => {
  void dispararRemarketing(e.currentTarget, 'qualificado');
});

$('alternar-afixar').addEventListener('click', async () => {
  await api('/leads/' + chatAberto + '/pin', {
    method: 'POST', body: JSON.stringify({ pinned: !leadAberto?.pinned }),
  });
  await actualizarConversa(false);
});

// "Aprovar" e dizer que validei o deposito a mao: o lead passa a estar no
// grupo, sai das campanhas de venda e entra no acompanhamento VIP.
$('alternar-vip').addEventListener('click', async () => {
  const aprovado = leadAberto?.stage !== 'acesso_liberado';

  // Aprovar manda o link do grupo ao lead. Nao e coisa para sair por engano
  // num toque distraido na lista.
  if (aprovado && !confirm('Aprovar e enviar-lhe já o link do grupo VIP?')) return;

  await api('/leads/' + chatAberto + '/aprovar', {
    method: 'POST', body: JSON.stringify({ aprovado }),
  });
  await actualizarConversa(true);
  carregarLista();
});

$('alternar-mao').addEventListener('click', async () => {
  const ligar = !leadAberto?.humanHandover;
  await api('/leads/' + chatAberto + '/handover', {
    method: 'POST', body: JSON.stringify({ enabled: ligar }),
  });
  await actualizarConversa(false);
});

async function enviar() {
  const texto = $('texto').value.trim();
  if (!texto || chatAberto === null) return;

  $('enviar').disabled = true;
  try {
    await api('/leads/' + chatAberto + '/reply', {
      method: 'POST', body: JSON.stringify({ text: texto }),
    });
    $('texto').value = '';
    $('texto').style.height = 'auto';
    await actualizarConversa(true);
  } catch (err) {
    alert(err.message);
  } finally {
    $('enviar').disabled = false;
  }
}

$('enviar').addEventListener('click', enviar);

// --- imagens ---
let imagemPronta = null;   // Blob ja reduzido, a espera de confirmacao

/**
 * Reduz a imagem antes de subir.
 *
 * Uma foto de telemovel tem 3 a 8 MB. Assim vai em centenas de kB: sobe num
 * instante em dados moveis e fica longe do tecto de 10 MB do Telegram. Feito
 * no canvas do proprio browser, sem biblioteca nenhuma.
 */
function reduzir(ficheiro, ladoMaximo = 1600, qualidade = 0.85) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onerror = () => reject(new Error('não consegui ler o ficheiro'));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('isso não parece uma imagem'));
      img.onload = () => {
        const escala = Math.min(1, ladoMaximo / Math.max(img.width, img.height));
        const tela = document.createElement('canvas');
        tela.width = Math.round(img.width * escala);
        tela.height = Math.round(img.height * escala);
        tela.getContext('2d').drawImage(img, 0, 0, tela.width, tela.height);
        tela.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('falhou a conversão'))),
          'image/jpeg',
          qualidade,
        );
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(ficheiro);
  });
}

$('anexar').addEventListener('click', () => $('ficheiro').click());

$('ficheiro').addEventListener('change', async (e) => {
  const ficheiro = e.target.files?.[0];
  e.target.value = '';           // permite escolher a mesma foto outra vez
  if (!ficheiro) return;

  try {
    imagemPronta = await reduzir(ficheiro);
    $('previa-img').src = URL.createObjectURL(imagemPronta);
    $('previa-legenda').value = $('texto').value.trim();
    $('previa').classList.add('activo');
  } catch (err) {
    alert(err.message);
  }
});

$('previa-cancelar').addEventListener('click', () => {
  imagemPronta = null;
  $('previa').classList.remove('activo');
});

$('previa-enviar').addEventListener('click', async () => {
  if (!imagemPronta || chatAberto === null) return;

  const botao = $('previa-enviar');
  botao.disabled = true;
  botao.textContent = 'A enviar…';

  try {
    const legenda = encodeURIComponent($('previa-legenda').value.trim());
    const r = await fetch(
      '/api' + prefixo + '/leads/' + chatAberto + '/image?caption=' + legenda,
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'image/jpeg' },
        body: imagemPronta,
      },
    );

    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.error || ('erro ' + r.status));

    imagemPronta = null;
    $('previa').classList.remove('activo');
    $('texto').value = '';
    $('texto').style.height = 'auto';
    await actualizarConversa(true);
  } catch (err) {
    alert(err.message);
  } finally {
    botao.disabled = false;
    botao.textContent = 'Enviar imagem';
  }
});

function ampliar(src) {
  $('lupa-img').src = src;
  $('lupa').classList.add('activo');
}

$('lupa').addEventListener('click', () => $('lupa').classList.remove('activo'));
$('texto').addEventListener('input', (e) => {
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
});

// Actualiza so com a conversa aberta e o separador a vista: sem isto o Render
// levava com pedidos de telemoveis esquecidos no bolso.
//
// Continua a existir por baixo do tempo real, como rede: se a ligacao de
// eventos cair e o browser demorar a reconectar, a conversa aberta actualiza-se
// na mesma, so que mais devagar.
function agendar() {
  clearInterval(temporizador);
  temporizador = setInterval(() => {
    if (chatAberto !== null && !document.hidden) actualizarConversa(false).catch(() => {});
  }, 15000);
}

/**
 * Liga o fluxo em tempo real.
 *
 * O EventSource reconecta sozinho quando a rede falha, por isso não há aqui
 * lógica de reconexão nenhuma — o browser trata disso.
 */
let fluxo = null;

function ligarTempoReal() {
  if (fluxo) fluxo.close();
  fluxo = new EventSource('/api/eventos');

  fluxo.addEventListener('mensagem', (e) => {
    const m = JSON.parse(e.data);

    // Nota interna: não é conversa, não mexe em nada do que se vê.
    if (m.interna) return;

    // Conversa aberta: a mensagem entra na hora.
    if (chatAberto === m.chatId) actualizarConversa(false).catch(() => {});

    // A lista sobe a conversa ao topo com a pré-visualização nova.
    carregarLista().catch(() => {});
  });

  // Lead novo: aparece no topo sem ninguém dar F5.
  fluxo.addEventListener('lead-novo', () => { carregarLista().catch(() => {}); });
  fluxo.addEventListener('lead-mudou', () => { carregarLista().catch(() => {}); });
}

async function arrancar() {
  const { authenticated } = await fetch('/api/session', { credentials: 'same-origin' })
    .then((r) => r.json()).catch(() => ({ authenticated: false }));

  if (!authenticated) { mostrar('login'); return; }

  mostrar('lista');
  await carregarBots();
  await carregarLista();
  ligarTempoReal();
}

arrancar();
</script>
</body>
</html>`;
