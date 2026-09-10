# El Pedrito

Backend autônomo de um funil de vendas no Telegram, construído sobre uma
**arquitetura híbrida de duas IAs em cadeia**:

| Papel | Modelo | Responsabilidade |
| --- | --- | --- |
| **Estrategista** | `gemini-3.6-flash` | Lê o histórico, classifica intenção/objeção/estágio e devolve uma **diretriz de vendas** em JSON. Nunca fala com o lead. |
| **Redator** | `gemini-3.5-flash` | Recebe a diretriz e o histórico e escreve a **mensagem final**, informal e persuasiva, que vai para o lead. |

Os dois papéis usam o Gemini e a mesma `GEMINI_API_KEY`, mas continuam
separados: o que sustenta a arquitetura é a divisão de responsabilidade — um
decide, o outro escreve — não o fato de serem provedores distintos. Os modelos
são trocáveis por `GEMINI_STRATEGIST_MODEL` / `GEMINI_WRITER_MODEL`.

O funil promove o grupo VIP **El Pedrito Tips**, lançado para portugueses
emigrantes na Suíça. O produto desta fase é a **entrada no grupo** — não o
casino. Entrar é gratuito; o acesso desbloqueia-se com registo e um depósito
mínimo na plataforma configurada, que fica como saldo do próprio lead. O acesso
só é libertado depois de validação **humana** do comprovativo.

Todo o atendimento é em **português de Portugal**.

---

## Arquitetura

```
Telegram ──update──▶ grammy ──▶ fila por chat_id
                                     │
                     ┌───────────────┴───────────────┐
                     │                               │
              SQLite (histórico)              Gemini · Estrategista
                     │                               │
                     │                        SalesDirective (JSON)
                     │                               │
                     └──────────────▶ Claude · Redator
                                             │
                                     texto final ──▶ Telegram
                                             │
                                     SQLite (persiste turno + diretriz)
```

Pontos de projeto que valem nota:

- **Fila por `chat_id`.** O Telegram entrega updates em paralelo e o lead
  costuma mandar três mensagens seguidas. Sem serialização, duas cadeias
  Gemini→Claude rodariam sobre o mesmo histórico e as respostas se
  contradiriam.
- **Degradação em vez de queda.** Se o Gemini falhar, uma diretriz
  conservadora assume (pergunta de qualificação, sem link). Se o Claude
  falhar, o lead recebe uma mensagem de "travou aqui" em vez de silêncio.
  Nenhum dos dois serviços lança exceção para cima.
- **Retry que respeita a quota.** O Gemini devolve `503 high demand` e `429`
  de quota com alguma frequência; sem retry isso vira turno perdido com o
  lead. O `429` traz um `retryDelay` dizendo quando a janela vira — um backoff
  de centenas de milissegundos nunca alcança esse prazo, então a espera é a
  maior entre o backoff e o que o servidor pediu, limitada a 20s.
- **Thinking mínimo nos dois papéis.** Os modelos Gemini 3.x raciocinam antes
  de responder e o thinking consome o mesmo orçamento de saída. O estrategista
  já recebe o contexto pronto e o redator não decide nada — pensar só
  adicionaria latência a uma mensagem de 1-3 frases.
- **Estágio só avança.** `advanceStage` ignora retrocessos causados por
  classificação ruidosa do Gemini. A única exceção é `perdido`, marcável a
  qualquer momento (opt-out do lead).
- **A diretriz é auditável.** Cada resposta do assistente guarda o JSON da
  diretriz que a gerou, na coluna `messages.directive`.
- **Transação explícita.** `node:sqlite` não tem o helper `transaction()` do
  `better-sqlite3`, então gravar a mensagem e somar o contador do lead corre
  dentro de um `BEGIN`/`COMMIT` próprio — sem isso uma falha no meio deixaria
  os dois fora de sincronia.

### Estágios do funil

`novo → qualificacao → apresentacao → objecao → registo_enviado → registado →
deposito_enviado → comprovativo_recebido → acesso_liberado` (+ `perdido`).

Os nomes antigos (`cadastro_enviado`, `cadastrado`, `depositado`) são mapeados
na leitura, para um lead a meio do funil não voltar a `novo` no primeiro deploy.

### Sequência de abordagem

A ordem importa mais do que o argumento, e é imposta em dois sítios:

| Turno | Conteúdo | Proibido |
| --- | --- | --- |
| 1-2 | Rapport: cantão, há quanto tempo na Suíça, se já aposta | Registo, depósito, link, valores, nome da plataforma |
| 3 | Comunidade, resultados e confiança na plataforma | Condição de entrada, link |
| 4 | Condição de entrada **+ pergunta de prontidão** | O link — ainda não |
| 5+ | Link, depósito mínimo, ancoragem e pedido do print | — |
| Depois | Validação humana do print | Aprovar automaticamente |

O link é a única coisa que exige um "sim" explícito antes de sair. A pergunta
de prontidão no turno 4 é o micro-compromisso; a confirmação chega no 5. Até
lá `linkAllowed()` trava-o **em código**, mesmo que a diretriz peça o
contrário — mandar o link cedo custa o lead duas vezes: perde-se o
compromisso, e a conversa passa a parecer o spam de casino que toda a gente já
recebeu.

### Lead que volta

Um `/start` de quem já falou connosco não reinicia nada: passa pela cadeia
normal com um marcador interno, o estrategista lê o histórico e o estágio, e a
resposta retoma o ponto exato onde a conversa parou. Um lead parado na pergunta
de prontidão recebe *"ainda por cá, Sandro? Ficaste com alguma dúvida ou estás
pronto para abrir a conta?"*, não a mensagem de boas-vindas.

O marcador **não é gravado no histórico**: contar `/start` como turno faria a
sequência de abordagem saltar fases a cada clique, e quem carregasse cinco
vezes chegaria ao link sem nunca ter falado.

### Objeções com resposta fixa

| Objeção | Ângulo |
| --- | --- |
| "Tenho de pagar alguma coisa?" | Nada a mim, grupo gratuito, sem mensalidades. O depósito é saldo dele. Fecha a perguntar se ficou esclarecido. **Sem link.** |
| "Já tenho conta noutra casa" | Motivo técnico: as entradas são dadas e conferidas nesta. Nunca difamar as outras casas. |
| "Vou pensar" / "faço depois do trabalho" | Não é um não: é alguém com vida. Aceitar com calma, ancorar o valor do dia sem inventar números, e pedir uma hora — como favor, nunca como cobrança. Sem link. |

### Promessa de depósito

Quando o lead dá uma hora ("saio às 18h30"), o estrategista extrai-a para
`promisedTime` e o bot guarda o instante em UTC. O agendador corre uma
passagem a cada minuto — não nos slots, porque a hora foi combinada com cada
lead — e envia um lembrete no tom do El Pedrito.

Este lembrete **ignora as horas de silêncio**: o lead pediu-o. O silêncio
existe para não incomodar quem não pediu nada.

Quem tem promessa pendente fica **fora do remarketing em massa** — dois
lembretes no mesmo dia é o que faz uma pessoa bloquear o bot. A promessa é
limpa antes do envio (uma falha não deixa o lead a receber o mesmo lembrete
todos os minutos) e também quando ele manda o comprovativo.

O estrategista recebe o número do turno e a sequência no prompt. Mas a
interdição das fases iniciais é **determinística**, calculada em
`phaseRule()` — é o único ponto do funil onde uma classificação errada custa o
lead na hora: pedir dinheiro à segunda mensagem queima a conversa e não há
volta. Com o estrategista em fallback, um lead que pergunte o preço no turno 1
continua a receber uma pergunta sobre o cantão, não um link.

A sequência pode andar mais devagar, nunca mais depressa. E quem já se
registou nunca é travado pelo turno.

### Prova social

`HIT_RATE_CLAIM` e `PAYOUT_CLAIM` guardam as afirmações de resultados citadas
antes do pedido de depósito. Ficam em variáveis, e não fixas no prompt, porque
são afirmações de facto que o bot repete tal e qual ao lead — com as duas
vazias, ele fala de assertividade sem citar números. O redator continua
proibido de inventar qualquer outro valor.

### Perfil do lead

O estrategista classifica cada lead e o redator adapta-se: `cetico`
(transparência e empatia, admite que as entradas falham), `sem_dinheiro`
(a entrada é gratuita e o depósito é saldo dele), `dificil` (paciência, uma
explicação de cada vez), `recetivo` (vai direto ao passo seguinte),
`indefinido` (pergunta aberta).

### Comprovativo de depósito

Quando o lead envia uma foto ou um ficheiro de imagem/PDF, o bot **não aprova
nada**: guarda o `file_id` da versão de maior resolução em `deposit_proofs`
como `pendente`, avança o estágio, responde que a validação está em curso, e
reencaminha-o para cada destino em `ADMIN_CHAT_IDS`. Aprovar automaticamente
daria acesso a quem enviasse qualquer imagem.

A legenda que acompanha cada comprovativo:

```
Comprovativo #12 — validacao manual

Nome: Sandro
Username: @sandro06
ID: 4242
```

Fotos seguem por `sendPhoto` e PDFs por `sendDocument` — um PDF enviado como
foto seria recusado pelo Telegram. Ambos por `file_id`, sem download nem
reupload.

`ADMIN_CHAT_IDS` aceita ids de pessoa e de grupo/canal (negativos). O default
no código é o canal de administração, para o reencaminhamento funcionar mesmo
num deploy onde a variável não foi configurada.

**O bot tem de pertencer ao grupo/canal e ter permissão para publicar lá.**
Sem isso o print fica guardado como `pendente` mas não chega a ninguém, e o
lead espera por uma validação que ninguém pediu. Quando nenhum destino
recebe, o log regista o erro explicitamente.

---

## Estrutura

```text
├── src/
│   ├── config/
│   │   └── env.ts            # Validação das variáveis de ambiente (zod)
│   ├── db/
│   │   └── database.ts       # node:sqlite: leads, histórico e estágios
│   ├── services/
│   │   ├── strategist.ts     # Gera a diretriz de vendas (JSON)
│   │   ├── writer.ts         # Escreve a mensagem final para o lead
│   │   └── retry.ts          # Retry compartilhado, respeita o 429 do Gemini
│   ├── telegram/
│   │   └── bot.ts            # Handlers, fila, rate limit, comandos
│   ├── utils/
│   │   └── logger.ts         # Logger com níveis
│   └── index.ts              # Servidor Express + bootstrap/shutdown
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Como rodar

```bash
npm install
cp .env.example .env      # preencha as chaves
npm run dev               # long polling, com reload
```

Produção:

```bash
npm run build
npm start
```

### Testar a cadeia sem o Telegram

```bash
npm run chat                       # REPL interativo
npm run chat -- "me manda o link"  # turnos roteirizados
```

Imprime a diretriz do estrategista antes da resposta do redator, que é o que
interessa ao calibrar os prompts. Usa um SQLite separado
(`./data/chat-harness.sqlite`) para não sujar o banco do bot.

Requer **Node.js 22.5+** — a persistência usa `node:sqlite`, o SQLite embutido
no runtime. O projeto **não tem nenhuma dependência nativa**: `npm ci` não
dispara `node-gyp` nem compila C++, então o build funciona em qualquer
plataforma sem toolchain (Render, Railway, Fly, containers slim).

### Variáveis obrigatórias

`TELEGRAM_BOT_TOKEN` e `GEMINI_API_KEY`. O boot falha com
uma lista explícita do que está faltando — não há default silencioso para
credencial. Todas as demais estão documentadas no `.env.example`.

Ajuste também os campos de negócio (`PLATFORM_NAME`, `AFFILIATE_LINK`,
`CURRENT_OFFER`, `MIN_DEPOSIT`, `AGENT_NAME`), que são injetados nos prompts
das duas IAs.

---

## Polling x Webhook

**O modo é decidido sozinho.** Havendo URL pública — `TELEGRAM_WEBHOOK_URL`, ou
`RENDER_EXTERNAL_URL` / `RENDER_EXTERNAL_HOSTNAME` que o Render injeta — o boot
usa webhook e o registra no Telegram. Sem ela, usa long polling.

**Em `NODE_ENV=production` com URL pública o webhook é imposto**, mesmo contra
um `TELEGRAM_MODE=polling` deixado para trás na plataforma. Numa plataforma que
hiberna por inatividade, o serviço em polling dorme, ninguém faz polling, e nada
volta a acordá-lo — o bot fica mudo até o próximo deploy, sem erro em lugar
nenhum. A imposição não é silenciosa: aparece nos logs e como
`modeSource: "forcado-em-producao"` no `/health`.

Produção **sem** URL pública nenhuma não derruba o boot: o serviço sobe e o
`/health` responde `degraded` dizendo qual variável falta. Um container em
crash-loop não conseguiria contar isso.

A URL registrada é `<URL pública>/webhook`, configurável por
`TELEGRAM_WEBHOOK_PATH`.

`TELEGRAM_WEBHOOK_SECRET` é opcional: sem ele, um valor estável é derivado do
token do bot. Exigir a variável faria o boot falhar em quem só configurou a
URL, e um deploy que não sobe ajuda menos que um segredo derivado.

O POST é aceito tanto em `/webhook` quanto no caminho derivado do token
(`/telegram/<cauda-do-token>`), que continua válido para não quebrar um webhook
já registrado nele. Ambos exigem o header `X-Telegram-Bot-Api-Secret-Token`;
sem ele, `401` — é o segredo que autentica a requisição, não a obscuridade do
caminho. Em modo polling as duas rotas respondem `409` explicando que aquele
servidor não entrega updates.

> **Ao mexer em `src/index.ts`:** o `webhookCallback()` da grammY não devolve
> apenas um handler — ele substitui `bot.start` por uma função que lança, no
> momento em que é criado. Construí-lo fora do modo webhook mata o long
> polling antes de ele começar, e o erro só aparece no boot.

### Quando o bot não responde

`GET /health` mostra o que o Telegram acha do webhook, sem precisar dos logs:

```json
{
  "status": "ok",
  "telegram": {
    "mode": "webhook",
    "botUsername": "seu_bot",
    "webhookRegistered": true,
    "pendingUpdates": 0,
    "lastError": null,
    "error": null
  }
}
```

`webhookRegistered: false` significa que o Telegram tem outra URL registrada.
`lastError` traz a última falha de entrega (certificado, 5xx, timeout).
`pendingUpdates` alto indica updates represados sem serem entregues.
`error` preenchido (com `status: "degraded"`) significa que a conexão com o
Telegram falhou no boot — o servidor sobe mesmo assim, para o `/health` poder
contar o motivo.

### Rotas HTTP

| Rota | Descrição |
| --- | --- |
| `GET /health` | Estado do registro no Telegram, uptime e o último erro de entrega. |
| `GET /stats` | Métricas do funil. Exige `x-admin-token` com o `TELEGRAM_WEBHOOK_SECRET` **configurado à mão**; com segredo derivado o endpoint fica desligado (`404`). |
| `POST /webhook` | Webhook do Telegram (a rota registrada no arranque). |
| `POST /telegram/<cauda-do-token>` | Mesmo handler; caminho legado, ainda aceito. |

---

## Comandos do bot

| Comando | Efeito |
| --- | --- |
| `/start` | Primeira vez: acolhimento e qualificação. Quem já tem histórico é reconhecido e a conversa retoma no ponto onde ficou — sem reset e sem repetir a apresentação. |
| `/reset` | Limpa o histórico e as anotações, mantendo o lead. |
| `/parar` | Opt-out: apaga o lead e todo o histórico. |
| `/stats` | Métricas do funil. Restrito aos `ADMIN_CHAT_IDS`; ignorado silenciosamente para os demais. |

---

## Limites embutidos nos prompts

Os dois prompts (estrategista e redator) carregam as mesmas restrições, para
que a diretriz não possa pedir o que o redator não pode escrever:

- nada de promessa de lucro garantido, "dinheiro fácil" ou valores de retorno;
- nada de números, prints, depoimentos, prazos ou vagas inventados;
- nunca pedir senha, código de verificação, cartão ou documentos;
- encerrar sem insistir quando o lead menciona dívida, vício, desespero
  financeiro ou idade abaixo de `MIN_AGE`;
- o link só sai quando o lead demonstra interesse concreto, e sempre
  acompanhado do `COMPLIANCE_NOTE`;
- nunca inventar percentagens de acerto: o redator só cita o que estiver em
  `HIT_RATE_CLAIM`, e com a variável vazia fala de assertividade sem números;
- nunca confirmar que o acesso ao grupo foi dado — quem valida é uma pessoa;
- se o lead perguntar diretamente se está falando com um bot, o redator
  assume que é um atendimento automatizado — a persona é informal, não é
  um disfarce.

Ajuste `COMPLIANCE_NOTE` e `MIN_AGE` conforme a regulação do seu mercado e as
regras do programa de afiliados que você divulga.

---

## Deploy

O build não exige toolchain nativa, então qualquer plataforma Node serve:

```
Build command:  npm ci && npm run build
Start command:  npm start
```

Configure as variáveis do `.env.example` no painel da plataforma. No Render
basta `NODE_ENV=production`, `TELEGRAM_BOT_TOKEN` e `GEMINI_API_KEY`: a URL
pública vem de `RENDER_EXTERNAL_URL` e o webhook é imposto a partir dela.
**Não defina `TELEGRAM_MODE`** — em produção ele é ignorado quando pede
polling, e a variável só serve para confundir o diagnóstico.

A porta HTTP sobe antes de qualquer chamada ao Telegram. As plataformas
derrubam o serviço que não liga a porta dentro de um prazo, e falar com o
Telegram primeiro significava que um token errado ou uma latência alta viravam
deploy falho em vez de erro diagnosticável.

**Atenção ao disco.** O `node:sqlite` grava num arquivo, e a maioria das
plataformas (Render incluído) tem sistema de arquivos efêmero: sem um disco
persistente montado, o banco é recriado a cada deploy e a cada restart, e a
memória de todos os leads se perde. Monte um disco persistente e aponte
`DATABASE_PATH` para dentro dele (ex.: `/var/data/funnel.sqlite`), ou troque a
persistência por um banco gerenciado. O esquema está isolado em
`src/db/database.ts` — só esse arquivo muda.

`node:sqlite` ainda é marcado como experimental no Node 22 (ele emite um aviso
no boot) e estável no Node 24. A API usada aqui — `DatabaseSync`, `prepare`,
`run`/`get`/`all`, `exec` — não mudou entre as duas versões.

## Remarketing automático

Três envios por dia (`REMARKETING_SLOTS`, no fuso dos leads), a dois públicos:

- **Não convertidos** — quem falou e não avançou. Tom de escassez, a reabrir a
  conversa. Sem link e sem repetir condições de entrada.
- **VIP** — quem já depositou. Retenção: puxa-os de volta ao grupo para verem
  as entradas do dia. Sem vendas; já compraram.

Uma chamada ao modelo por slot e por público, personalizada depois com o nome
de cada lead. Gerar por lead multiplicaria as chamadas pelo tamanho da base e
esgotaria a quota a meio da lista. Sem modelo disponível há guiões de reserva
— uma campanha que falha em silêncio parece estar a funcionar.

**A marca de slot vive na base de dados.** O Render reinicia o serviço a toda
a hora, e sem isso cada reinício dentro da janela reenviaria a campanha
inteira ao mesmo lead.

Ficam sempre de fora: quem está em `perdido` (inclui quem pediu para parar e
quem mencionou dívida ou vício), quem bloqueou o bot, quem falou connosco nas
últimas `REMARKETING_QUIET_HOURS`, e quem já recebeu
`REMARKETING_MAX_TOUCHES` lembretes. Um `403` do Telegram marca o lead como
bloqueado e ele nunca mais é contactado.

## Custo e limites do plano gratuito

A cadeia gasta **duas chamadas por mensagem do lead** (estrategista + redator).
No plano gratuito do Gemini a quota é contada **por modelo**
(`GenerateRequestsPerMinutePerProjectPerModel`), então manter os dois papéis em
modelos diferentes é o que dobra o teto efetivo — é por isso que os defaults
não coincidem.

Mesmo assim o limite é baixo para um funil com volume: são poucas requisições
por minuto e por modelo, somando **todos** os leads ao mesmo tempo. Ao estourar,
o retry espera o prazo que o próprio Gemini indica; se ainda assim não passar,
o lead recebe a mensagem de fallback em vez de silêncio. Para volume real,
ative o faturamento no Google AI Studio.

`npm run models` lista os modelos que a sua chave serve — útil porque o Google
retira modelos antigos: `gemini-1.5-flash` e `gemini-2.0-flash` já respondem
404.

## Privacidade

O banco guarda conteúdo de conversas privadas: `chat_id`, nome, username e
todas as mensagens. Trate o arquivo como dado pessoal — ele fica fora do git
(`data/` está no `.gitignore`), deve ficar em volume com backup controlado, e
`/parar` existe para atender pedidos de exclusão.
