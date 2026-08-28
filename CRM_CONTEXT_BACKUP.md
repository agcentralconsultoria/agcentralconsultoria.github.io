# CRM Angelo Garcia — Backup de Contexto

Registro completo do projeto: arquitetura, decisões, regras de negócio,
comportamentos definidos, roteiro e estágio atual. Feito pra não perder nada
importante quando a conversa for limpa/compactada. **Ver também `CLAUDE.md`**
para as regras rápidas do dia a dia.

Este documento é vivo — quando decisões novas forem tomadas, atualize a seção
correspondente em vez de só ir empilhando no fim.

---

## 1. Quem é o usuário e por que este CRM existe

Ângelo Garcia — treinador e nutricionista online, baseado em São Gonçalo/RJ.
Leigo em programação, no plano Claude Pro (básico), consciente de gasto de
token. Comunicação sempre em PT-BR, direta, sem jargão técnico. Sua
colaboradora **Débora** também usa o CRM (daí "Mentora - Debora" no caminho da
pasta local).

Substituiu uma planilha Excel complexa (`Agosto - Acompanhamento_Pacientes_CRM
1.xlsx`, usada como inspiração de estrutura, não como spec fiel) por este CRM
web de arquivo único. Já tentou Netlify Drop, GitHub Pages "cru" e uma versão
React+Babel antes de assentar em **HTML/CSS/JS puro, sem build, sem
framework** — essa é a decisão de arquitetura validada; não reintroduzir
frameworks/build steps sem motivo forte e sem perguntar antes.

**Regra de ritmo/token** (dada 21/08/2026, ainda vale): quando o limite de
tokens da sessão/semana estiver baixo (~15% ou menos), **não começar uma
feature grande nova** (ex: uma área inteira nova da Captação). Avisar
explicitamente e sugerir fechar a sessão num ponto limpo (já commitado e no
ar) em vez de arriscar ficar pela metade. O fluxo de trabalho já protege
contra "site quebrado" (só dá `git push` depois de testar tudo) — o risco real
é só "não terminei a próxima feature", nunca o CRM ficar fora do ar.

---

## 2. Arquitetura técnica

- **Um único `index.html`** (~550KB), vanilla JS/HTML/CSS. Toda a lógica de
  negócio e render fica dentro de UMA IIFE (`(function(){ "use strict"; ... }
  )();`) num único `<script>`. Não há módulos, não há bundler.
- **Persistência: Firebase** (Firestore + Authentication, SDK modular via
  `<script type="module">` que popula `window.__mfa`). Migrado de localStorage
  pra Firebase em 2026-08-1x (commit `2b08350`) — **qualquer nota antiga de
  memória que mencione localStorage como fonte de dados está desatualizada**,
  hoje é só um fallback/cache local, a fonte de verdade é o Firestore.
  - Documentos principais: `crmData/patients` (lista de pacientes),
    `crmData/captacao` (leads, parcerias, indicações, comunidade, etiquetas),
    `crmData/captacaoTemplates` (modelos de jornada de lead/parceria),
    `crmData/jornadaTemplates` (modelos de jornada de paciente),
    `crmData/grupoMuscularList`.
  - Autenticação: e-mail/senha + **2FA via TOTP** (Google Authenticator),
    implementado em 2026-08-1x. Troca de senha só é permitida via link
    enviado para um e-mail autorizado específico
    (`SENHA_EMAIL_PERMITIDO` no código) — travado de propósito, mesmo que
    outra conta faça login no futuro.
- **Deploy: GitHub Pages**, organização `agcentralconsultoria`, repo
  `agcentralconsultoria/agcentralconsultoria.github.io`, branch `main`.
  `git push origin main` já publica — sem passo extra. Domínio customizado
  `agcentral.com.br` configurado via `CNAME`. `.nojekyll` presente de
  propósito (sem ele o Pages tenta processar como Jekyll e atrasa/quebra).
  Build leva ~15-30s pra ficar `built` (`gh api repos/.../pages/builds`).
- **Site real e diário do usuário**: o Ângelo usa a URL publicada de verdade
  para trabalhar com pacientes reais — **todo commit precisa ser seguido de
  push pra ele ver a mudança**. Nunca deixar código só commitado localmente
  sem avisar/publicar.
- **Sem Node/npm neste ambiente Windows** — pra checar sintaxe de um arquivo
  JS grande, usar `new Function(code)` no browser (via Browser pane), não
  tentar `node -c`.
- **Backup manual embutido no CRM**: botões "Exportar"/"Importar" na aba
  Pacientes (`exportBtn`/`importBtn`) baixam/restauram um JSON com TUDO —
  `patients`, `jornadaTemplates`, `grupoMuscularList`, `captacao`,
  `captacaoTemplates` — não é só os pacientes. Importar **substitui todos os
  dados atuais** (confirmação explícita antes). Isso é o mecanismo de backup
  manual do usuário, separado do Firestore — não remover nem trocar o
  formato sem pensar em compatibilidade com backups antigos que ele já pode
  ter salvo no computador dele.

### Padrões de código internos

- `state` = objeto global de estado de UI (não persistido diretamente — os
  dados persistidos vivem em `state.patients`, `state.captacao`,
  `state.captacaoTemplates`, `state.jornadaTemplates`, sincronizados com
  Firestore via `save*()` / `load*Async()`).
- Convenção de nomes: `xHtml()` gera markup; `bindXEvents()` liga listeners
  depois do render; `refreshX()` chama as duas (re-renderiza uma parte
  específica sem re-renderizar a tela inteira).
- **Reaproveitamento por cópia-e-adaptação, não por generalização agressiva.**
  Quando uma feature nova é parecida com uma existente (ex: Parcerias
  reaproveitando o motor de Jornada de Lead; planos Essencial reaproveitando a
  estrutura do "só Treino" quinzenal), o padrão estabelecido é copiar a lógica
  com nomes/atributos `data-*` próprios, não generalizar a função original —
  isso evita risco de regressão em algo que já funciona e que o usuário usa
  todo dia. Só generalizar quando o risco for baixo (ex: um editor de modelo
  administrativo, não usado no fluxo diário).
- Escape HTML sempre via `esc()`. IDs sequenciais via `next*Id()` (maior id
  existente + 1).

### Metodologia de teste (login Firebase impede automação direta)

Não é possível logar automaticamente no site real (política de segurança —
nunca digitar senha em nome do usuário). O fluxo de teste estabelecido:

1. Extrair funções reais do `index.html` **verbatim** (nunca reescrever do
   zero) + o CSS real (`sed -n '/^<style>/,/^<\/style>/p' index.html`) pra um
   HTML de teste isolado no diretório de scratchpad da sessão.
2. Servir com um servidor PowerShell simples
   (`System.Net.HttpListener`, via `.claude/launch.json` + `preview_start`) —
   `file://` tem limitações de CORS/fetch que atrapalham.
3. Interagir de verdade pelo Browser pane (cliques reais via `computer`, não
   só `dispatchEvent` sintético — sintético não reproduz nuances reais de
   foco/clique do navegador; isso já mordeu uma investigação de bug de
   "precisa clicar duas vezes").
4. Sempre testar em mobile (375px, `resize_window` preset mobile) além do
   desktop — regra fixa do usuário (ver seção 3). **Se `resize_window`
   preset mobile não aplicar de verdade** (sintoma: `window.innerWidth`
   continua ~980px mesmo depois do preset, geralmente porque o painel de
   preview não está sendo exibido/composto naquela sessão) — não insistir
   tentando várias vezes nem se contentar com "provavelmente funciona por
   CSS". Usar a alternativa que já funcionou: criar um HTML simples com
   `<iframe src="test.html" style="width:375px;height:812px;">` — um
   iframe tem largura de CSS própria, independente do tamanho da janela
   por fora, então o conteúdo dentro renderiza em 375px de verdade não
   importa o estado do painel. Confirmar com
   `f.contentWindow.innerWidth === 375` e
   `f.contentDocument.documentElement.scrollWidth === 375` (sem overflow)
   antes de validar visualmente.
5. Pra testar o **app inteiro renderizado** de verdade (não só uma função
   isolada): pegar o `<script>` inteiro, trocar o `init()` final por um
   bootstrap que popula `state` com dados fake e stuba `mfa` (evita chamadas
   reais ao Firebase), e servir com os 4 elementos-raiz que o app espera:
   `#app`, `#modal-root`, `#toast-root`, `#chart-expand-root` — esquecer
   qualquer um desses gera erros enganosos tipo "Cannot set properties of
   null" que parecem bug de lógica mas são só o fixture de teste incompleto.
6. `rm -rf .claude` do projeto real antes de commitar (infraestrutura de
   teste, não deve ir pro repo).

---

## 3. Regras fixas de comportamento (confirmadas, não renegociar sem pedir)

1. **Mobile sempre.** Todo ajuste visual precisa funcionar em celular — testar
   em 375px sempre, além do desktop, antes de dar como pronto. Regra dada
   explicitamente e reforçada várias vezes.
2. **Escopo cirúrgico.** "Faça somente essa alteração" é praticamente padrão
   nos pedidos dele. Não refatorar, não "aproveitar pra melhorar" outra
   coisa, não mudar comportamento de partes que já funcionam. Sinalizar
   problemas fora do escopo sem implementar sem pedir.
3. **Testar antes de declarar pronto.** Nunca dizer que uma correção está
   pronta sem validar de verdade (lógica isolada + visual, mobile incluso).
4. **Perguntar antes de assumir regra de negócio ambígua.** Quando a tarefa
   envolve decisão que pode gerar retrabalho (critério de risco, o que conta
   como "novo registro", qual dado é fonte de verdade, onde vai a borda
   colorida etc.), perguntar objetivamente via `AskUserQuestion` em vez de
   supor — ele prefere isso a ter que corrigir depois.
5. **Nunca inventar regra de negócio que não foi definida.** Ex: comissão de
   Parceria nunca foi especificada em lugar nenhum — quando perguntado, a
   resposta certa é dizer isso claramente, não inventar uma regra plausível.
6. **Fechar/atalho explícito, não toggle por reclique.** Painéis
   expansíveis/drill-downs devem ter um controle de fechar visível (botão ×)
   em vez de fechar reclicando no mesmo botão que abriu — preferência
   confirmada desde os primeiros KPIs do Dashboard, repetida depois.
7. **Correções pontuais > redesign amplo.** Quando ele aponta um bug
   específico, corrigir a causa raiz sem redesenhar a funcionalidade ao redor.
8. **Confirmar posicionamento visual exato** (esquerda/direita, qual tabela
   específica) em pedidos cosméticos — já ocorreu dele pedir um emoji "ao lado
   do nome" e a primeira posição/tabela escolhida ter sido errada; não é
   adivinhável a partir de "bom senso".
9. **Perguntas devem ser concretas, com exemplo antes/depois.** Perguntas
   abstratas ("agrupar por paciente, recolhível?") já geraram "Não entendi a
   pergunta"; frases com exemplo concreto ("hoje aparece assim: X — depois
   ficaria assim: Y") funcionam melhor. Mesmo com opções de múltipla escolha,
   ele às vezes escolhe uma terceira opção que não estava listada — está OK,
   é sinal de que a pergunta ajudou a esclarecer o que ele queria, não que
   fechou errado.
10. **Nunca escrever/ler arquivo com acentuação via PowerShell sem
    `-Encoding UTF8` explícito.** O padrão de leitura do PowerShell 5.1 pra
    arquivo sem BOM é Windows-1252, não UTF-8 — já corrompeu texto em PT-BR
    (ex: "Observações" → "ObservaÃ§Ãµes") duas vezes seguidas num mesmo
    round-trip. Sempre `-Encoding UTF8` ou
    `[System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)`.
11. **Blob grande (base64 etc.) nunca via Edit com transcrição manual.**
    Transcrever uma string de 24k+ caracteres através do modelo já corrompeu
    silenciosamente uma imagem embutida. Preferir regex/`MatchEvaluator` via
    script, sem o blob passar pelo "olho" do modelo.
12. Quando o usuário colar uma **imagem direto no chat** (não um caminho de
    arquivo), o clipboard do Windows ainda a tem — usar
    `[System.Windows.Forms.Clipboard]::GetImage()` via PowerShell pra
    recuperar antes de pedir de novo. **Nem sempre funciona** — já ocorreu de
    não haver caminho de arquivo recuperável de jeito nenhum (imagem colada
    sem passar pelo clipboard do SO, ex: de dentro de outro app); nesse caso,
    avisar o usuário claramente que a imagem foi vista mas os bytes não são
    acessíveis, e pedir um caminho de arquivo real ou reenvio por outro meio
    — não seguir em frente sem os dados reais.
13. **Testar e publicar sozinho, sem perguntar "posso publicar?"** (regra
    dada 26/08/2026, depois de ele notar duas mudanças prontas mas não
    publicadas). Assim que uma mudança for testada (desktop **e** mobile
    375px) e estiver OK, fazer `commit` + `git push origin main` direto.
    Mobile funcionando é parte da definição de "pronto", não um passo à
    parte. Só segurar a publicação se um teste realmente falhar ou se sobrar
    alguma decisão que só ele pode tomar.

---

## 4. Modelo de dados — Paciente

```
patient = {
  id, nome, email, telefone (WhatsApp), nascimento,
  plano: 'Avulso' | 'Trimestral' | 'Semestral' | 'Anual'
       | 'Essencial Trimestral' | 'Essencial Semestral',
  servico: 'Treino' | 'Dieta' | 'Treino + Dieta',
  prioridade: 'Modo Bebezinho' | 'Urgente' | 'Moderada' | 'Sem urgência',
  vencimento (data),           // vigência do plano — status é sempre calculado, nunca manual
  consulta (data),              // próxima consulta — status também calculado
  materialPos (bool),           // material pós-consulta enviado?
  isNovoPaciente (bool),         // desmarcar exclui da contagem de "novo" na Comparação Mensal
  createdAt (contador),  createdDate (ISO — usado p/ "Últimos Pacientes" 30 dias reais),

  fichasTreino: [ { id, dataPassado, dataVencimento, expectativa,
                     volumePorGrupo: {grupo: series}, current-most-recent = idx 0 } ],
  fichasDieta:  [ { id, dataPassado, expectativa, tipo:'linear'|'ciclo',
                     calorias/proteinas/carboidratos/gorduras/fibras (linear),
                     variacoes: [{nome, dias:[], calorias...}] (ciclo, sempre 2),
                     livresTipo:'calorias'|'refeicao', livresKcal, livresObs } ],

  meses: {
    'YYYY-MM': {
      metaMes, metaTipo:'outro'|'peso', metaPesoMin, metaPesoMax, metaPesoInicio,
      observacoes,
      engajamento: [null|0-10, ...],   // 1 por "semana" (sexta) do mês
      checkin: [null|true|false, ...], // idem
      obsCheckin: ['', ...],
      peso: [null|kg, ...],            // 1 slot por semana, mas registro POR DATA (ver §6)
      pesoData: [null|'YYYY-MM-DD', ...] // data explícita de cada peso, quando existir
    }
  }
}
```

- **Status calculados, nunca manuais**: Renovação (`renovacaoStatus`) e Status
  da Consulta (`consultaStatus`) são sempre derivados de datas — os
  dropdowns manuais foram removidos de propósito. Renovação:
  `Ativo` (>40 dias) → `Renovação próxima` (31-40 dias, amarelo) →
  `Renovação antecipada` (últimos 30 dias) → `Vencido` (passou). Consulta:
  verde ≥16 dias, amarelo ≤15 dias, vermelho se já passou.
- **Vencido = inativo**, some das telas de trabalho normais (Pacientes,
  Visão Geral, Últimos Pacientes, Pacientes em Risco) e vira um card
  "Pacientes Inativos" no Dashboard com botão "Ativar" (que só abre o form de
  edição — atualizar a Vigência é o que reativa, não existe flag separada).
- Prioridade, ordem de urgência: **Modo Bebezinho > Urgente > Moderada > Sem
  urgência**.
- **Janela do check-in semanal, sexta a segunda** (regra dada pelo Ângelo em
  28/08/2026): cada semana de check-in "oficialmente" cai numa sexta-feira
  (`nthFridayDate`), mas se o paciente manda o check-in/peso no sábado,
  domingo ou segunda, ainda conta como aquela semana. Terça/quarta/quinta
  ficam fora de qualquer janela — não pertencem a semana nenhuma. Implementada
  em `weekIndexForDate(monthKey, dateStr)` ([index.html](index.html)) e usada pra
  casar um peso com data explícita (registrado via "+ Registrar peso"/"Editar
  peso") com a "Observação do Check-in" certa no tooltip de "Evolução do
  peso" e ao salvar a observação pela tela de editar peso. Sem data explícita
  (peso lançado direto na grade semanal), a semana já é a própria posição no
  array, então nada muda pra esse caso.

---

## 5. Semanas, quinzenal e planos Essencial (regra de cadência)

- `weeksInMonth(monthKey)` conta sextas-feiras reais do mês (4 ou 5, nunca
  hardcoded).
- **"Só Treino" (serviço = Treino) é quinzenal**: check-in/engajamento só nas
  semanas 1 e 3 (índices 0 e 2), as outras ficam desativadas e fora da média;
  limite de faltas pra risco cai pela metade (1, em vez de 2). Caixas mescladas
  na Visão Geral ("Sem 1/2", "Sem 3/4[/5]").
- **Planos Essencial Trimestral/Essencial Semestral** (adicionado
  2026-08-2x): acompanhamento **mensal**, reaproveitando a MESMA estrutura do
  quinzenal (função genérica de "índices ativos por cadência"), mas com regra
  própria:
  - **1 único check-in por mês** (1 caixa cobrindo o mês inteiro, não 2 como
    o quinzenal).
  - **Engajamento não existe pra Essencial** — nunca. Some do Perfil, some do
    editor rápido de semana, nunca conta em pendências. Precedência: se um
    paciente for Essencial E serviço=Treino ao mesmo tempo, Essencial vence
    (mensal, não quinzenal).
  - Risco (`engagementRisk`) pra Essencial: **não enviar o único check-in do
    mês já conta como risco** (limite de faltas = 0, confirmado explicitamente
    pelo usuário via pergunta objetiva — não era óbvio, foi checado antes de
    implementar).
  - **Peso continua semanal normalmente**, independente do plano — não é
    afetado pela cadência mensal/quinzenal (peso é registrado por data, não
    por "semana do check-in").
  - Não altera em nada o comportamento de Avulso/Trimestral/Semestral/Anual
    nem do quinzenal existente — testado explicitamente pra confirmar isso.

---

## 6. Peso — como é armazenado e as duas correções feitas (importante)

`p.meses[mes].peso[i]` e `pesoData[i]` são arrays paralelos, um slot por
índice de "semana" do mês — **mas o peso pode ser de qualquer dia**, não só
sexta. `nthFridayDate(mes, i)` é usado só como fallback de exibição quando não
há `pesoData[i]` explícito (ex: peso digitado pela grade semanal genérica do
formulário, que não tem campo de data próprio).

**Dois bugs reais já corrigidos aqui, importantes pra não reintroduzir:**

1. **Slot "livre" tem que ser decidido pelo array `peso`, não por `pesoData`.**
   `nextFreePesoSlot()` antes checava `pesoData.indexOf(null)` — um peso
   lançado pela grade semanal (sem data explícita, `pesoData[i]=null` mesmo
   com peso preenchido) era tratado como "livre" e o próximo clique em
   "+ Registrar peso" sobrescrevia esse peso em silêncio. Corrigido pra
   checar `peso.findIndex(v => v==null)` em vez disso. **Se qualquer feature
   nova mexer em slots de peso, usar sempre o array `peso` como fonte de
   verdade de "ocupado", nunca `pesoData`.**
2. **`mergeWeeklyIntoMonth()` existe pra não perder `pesoData` ao salvar o
   formulário Editar Paciente.** Antes, salvar o form fazia
   `p.meses[key] = weekly` (substituição direta) — como o formulário não
   conhece `pesoData`, isso apagava as datas reais de todos os pesos do mês a
   cada "Salvar". A correção faz merge: mantém a data de cada peso
   preenchido, limpa a data junto quando o peso é apagado, preserva
   registros além do número de caixas do mês, e não descarta outros campos já
   gravados no mês que o formulário não edita.

Outras regras de peso: duas casas decimais preservadas (não arredondar pra
uma). Histórico de peso pagina de 5 em 5 (`< pág/total >`), com botão de
excluir (com confirmação) ao lado do editar. "+ Registrar peso": **Enter** no
campo de data ou peso salva igual ao botão (mesmo comportamento, não
diferente).

---

## 7. Ficha de Treino / Ficha de Dieta

- Cada ficha nova vira a "Atual" (badge azul), a anterior vira "Substituída"
  (cinza) — `idx === 0` é sempre a mais recente. **Borda laranja** ao redor da
  ficha vigente (treino e dieta) pra identificar rápido qual é a atual,
  reaproveitando o mesmo padrão visual usado nos cards de KPI selecionados do
  Dashboard.
- Botões "+ Nova ficha" renomeados pra **"Adicionar novo Treino"** /
  **"Adicionar nova Dieta"** (nos dois lugares: Editar Paciente e Perfil do
  Paciente).
- **Dieta em ciclo de carboidrato**: 2 variações, cada uma com seus próprios
  dias da semana (não pode repetir dia entre as duas, aviso visual se
  repetir). Comparativo mostra as duas coladas por ficha + total de kcal da
  semana.
- **Extra semanal da dieta**: "Calorias livres" (a pessoa segue a dieta E come
  a mais — soma no total) OU "Refeição livre" (troca uma refeição por outra
  coisa). **Desde 2026-08-2x, os dois tipos somam no total da semana**
  (antes só "calorias livres" somava; mudança pedida explicitamente pelo
  usuário). Cada ficha tem também um campo de **anotação livre** (textarea,
  mesma largura do campo de kcal, redimensionável como na Jornada) que **não
  entra em nenhum cálculo** — é só anotação solta.
- **Comparação "Volume por grupamento muscular"** (treino): as barras de cada
  ficha comparada ficam **coladas** (gap:0) dentro de cada grupo muscular —
  pedido explícito ("juntar a parte separada"). A comparação de dieta
  (calorias/macros) **não foi alterada**, continua com o espaçamento normal.
- **Bug de precisar clicar duas vezes** (calorias/macros da dieta e Volume
  por grupo muscular do treino, ao Editar Paciente): causa raiz era que
  alguns campos (data de Passado/Vencimento, e macros) re-renderizavam a
  lista INTEIRA de fichas a cada blur/change só pra atualizar o cabeçalho ou
  o painel de g/kg — isso destruía e recriava o próximo campo bem no meio do
  clique do usuário. Corrigido pra atualizar só a parte que muda (cabeçalho
  da ficha via `refreshFichaHeaderInPlace`, ou o painel de g/kg/distribuição)
  sem re-renderizar a lista inteira. **Padrão a evitar em features novas**:
  nunca fazer `root.innerHTML = listaInteira()` dentro de um handler de
  `blur`/`change` de um campo que tem outro campo editável logo depois dele
  no DOM — isso é a causa raiz clássica desse tipo de bug.

---

## 8. Dashboard — regras e KPIs

> ⚠️ **Cuidado com nome ambíguo**: existem DUAS telas diferentes chamadas
> "Visão Geral" no CRM — (1) a tabela semanal de engajamento/check-in dentro
> da aba **Pacientes** (`overviewTableHtml`, o que a §9 abaixo descreve), e
> (2) a sub-aba **Captação → Visão Geral** (`cap-visao`, indicadores da
> captação + Agenda, ver §11/§12). São coisas totalmente diferentes que só
> coincidem no nome — confirmar sempre qual das duas o usuário quer dizer.

- KPIs principais (grid, clicáveis, abrem drill-down com **botão ×
  explícito** pra fechar, nunca fecha reclicando): Pacientes Ativos, Vencendo
  em 15 dias, Consulta Próxima, Aniversariantes da Semana, Pacientes
  Inativos, Renovação Próxima, Renovação Antecipada.
- **Fichas de Treino** (seção própria, `kpi-grid-sm`, 2 cards menores):
  Ficha de Treino Vencida / Ficha de Treino a Vencer — considera a ficha de
  treino mais recente de cada paciente ativo; Vencida = já passou do
  `dataVencimento`; A Vencer = vence em até 15 dias.
- **Acesso Rápido** (seção com 6 cards independentes, cada um colapsável na
  hora e com ordenação própria — "pontos de atenção que passam batido no dia
  a dia"):
  1. **Sem Atualização Recente — Treino** / **Dieta**: dias desde a
     `dataPassado` da última ficha de cada paciente que contrata aquele
     serviço, ordenável, com toggle de unidade de exibição.
  2. **Vencimentos**: lista de vencimento de plano, ordenável.
  3. **Sem Consulta Marcada**: quem está com Status da Consulta
     atrasado/sem data.
  4. **Sem Vigência**: paciente sem `vencimento` preenchido.
  5. **Resumo de Entrega de Paciente**: lista de **pendências por paciente**
     (`pendenciasPaciente`) — só aparece quem tem algo faltando, ordenado do
     que falta mais pro que falta menos. Verifica: telefone, e-mail,
     nascimento, vigência, consulta, engajamento/check-in das semanas **que
     já ocorreram** (semana futura nunca conta como pendência —
     `semanasJaOcorridas`, e usa `activeEngagementIndexes`/`activeWeekIndexes`
     pra respeitar quinzenal/Essencial), ficha de treino + volume por grupo
     (só se `temServicoTreino`), ficha de dieta + macros (só se
     `temServicoDieta`), e Jornada do Paciente iniciada.
- **Pacientes em Risco**: engajamento médio abaixo de 8 OU mais de 2
  check-ins não enviados no mês (semanas em branco não contam) — limite de
  faltas cai pela metade pro quinzenal (1) e vira 0 pro Essencial mensal (ver
  §5). Card com mês no formato `MM/AAAA`, contador em vermelho ao lado do
  título, fundo vermelho claro + borda vermelha na caixa da lista.
- **Últimos Pacientes**: quem foi cadastrado nos últimos 30 dias reais
  (`createdDate`) **mais** quem está em "Modo Bebezinho" (fica indefinidamente
  até sair dessa prioridade) — não é mais um "últimos 5" simples.
- **Material Pós-Consulta Pendente**: lista dedicada (mesmo padrão de
  "Pacientes em Risco"), não uma coluna a mais na Visão Geral (decisão
  consciente pra não poluir a tabela já densa).
- **"Ver semanas" (mini calendário)**: dia de hoje ganha borda laranja pra
  identificar rápido, mesmo quando coincide com uma sexta (as duas bordas
  convivem, testado).
- **Comparação Mensal**: últimos 6 meses lado a lado (engajamento médio, %
  check-in, pacientes em risco, novos cadastros), mês atual destacado.
- Padrão geral do CRM pra "quem precisa de atenção": **lista/card dedicado**
  (Pacientes em Risco, Aniversariantes, Inativos, Material Pendente, cada
  card do Acesso Rápido), não coluna extra numa tabela grande já cheia — usar
  esse padrão por default quando surgir um pedido novo desse tipo.

---

## 9. Busca / Filtros (aba Pacientes)

- **Visão Geral (tabela semanal da aba Pacientes — não confundir com a
  sub-aba Captação → Visão Geral, ver aviso no §8), busca por nome**:
  flexível — ignora acento e
  maiúsculas/minúsculas, e cada palavra digitada é comparada separadamente
  (não precisa ser a frase inteira nem na ordem do cadastro). Buscar só
  sobrenome, só nome, partes do nome, ou nomes fora de ordem ("Souza João"
  acha "João Souza") tudo funciona.
- **Colunas com filtro** (Plano/Prioridade/Status na tabela principal, Status
  Consulta na Visão Geral): clicar no cabeçalho da coluna abre um popover de
  seleção única (não checkbox multi-select, não é sort — essas colunas
  perderam a capacidade de ordenar). Só "Nome" continua clicável pra
  ordenar na tabela principal.
- Visão Geral tem filtros próprios (Nome, Status Consulta, Média por banda:
  Ruim <7 / Mediano 7-8 / Bom ≥9), independentes da busca da tabela principal.
  Ordem padrão: pior engajamento primeiro (quem não tem dado ainda vai pro
  final, não é tratado como "ruim").

---

## 10. Jornada do Paciente (aba própria "Jornada")

- Motor: **modelo com ações em dias relativos (Dia 0, Dia 3...) que viram
  tarefas com data real** ao aplicar. Editável: renomear, duplicar, criar
  modelo, adicionar/editar/remover ação (nome, dia, canal/fase).
- Seleção de jornada é **independente** de Plano/Serviço do paciente — campos
  próprios "Tipo de Jornada" (Nenhuma/Trimestral/Semestral) e "Foco"
  (Treino+Dieta/Só Treino/Só Dieta), pré-preenchidos a partir de
  Plano/Serviço só como conveniência inicial, nunca re-sincronizados depois.
- 6 modelos-base (tipo × foco), totalmente editáveis, com duplicação
  (nome escolhido na hora), sem afetar pacientes que já geraram a jornada
  (cópia congelada por paciente).
- **Kanban "O Que Fazer Agora"**: 1 coluna por paciente com tarefa
  atrasada/próxima, ordenado por Prioridade do paciente primeiro, urgência da
  tarefa como desempate. Colunas colapsáveis. Cartão duplicável (aparece logo
  abaixo do original). Cor por prazo: verde/amarelo/vermelho conforme dias.
  Tarefa marcada pra depois da vigência do plano ganha vermelho forte + selo
  com a data de vencimento.
- **Arquivo/Histórico**: seguindo o padrão real do Trello mostrado pelo
  usuário via prints — marcar concluído **não remove** o cartão da vista
  (fica esverdeado/riscado no lugar); "arquivar" é uma ação separada e
  deliberada; existe uma tela de Histórico/Arquivo listando tudo, com botão
  de excluir tudo de um paciente de uma vez.
- Campo por tarefa é só **Observação livre** ("O que fazer / mensagem a
  enviar") — ele não quis mensagens pré-escritas, só um campo em branco.

---

## 11. Área de Captação — arquitetura geral

Documento fonte original: artefato Claude publicado **"Arquitetura da
Captação"** (relia-lo se precisar do texto exato — `Artifact action:"list"`
pra achar o link, já que ele muda por sessão). Princípio central: **"uma
pessoa = um registro"** — Lead é a fonte única de quem está em processo
comercial; Social Selling não cria ninguém (é filtro de Leads); Indicação
cria ou vincula um Lead; a Agenda não guarda nada, só lê tarefas que já
existem nas outras áreas (concluir na Agenda conclui na origem, é o mesmo
registro).

**Ordem de construção combinada** (do artefato, seguida à risca):
Sidebar → Leads com Kanban → Jornadas de Lead → Agenda → Indicações →
**Parcerias** → Social Selling → Comunidade → **Visão Geral por último**
(ela depende de tudo mais existir).

### Estágio atual (26/08/2026)

| Etapa | Status |
|---|---|
| Sidebar com grupo Captação (5 sub-abas) | ✅ Pronto |
| Leads (Kanban, 5 etapas, temperatura, etiquetas) | ✅ Pronto |
| Jornadas de Lead (motor reaproveitado, 6 modelos) | ✅ Pronto |
| Agenda de Captação | ✅ Pronto (lê Leads + Parcerias + Comunidade) |
| Indicações (placar, marcos, conversão automática) | ✅ Pronto |
| **Parcerias** | ✅ Pronto (26/08/2026 — ver §12) |
| ~~Social Selling~~ | ❌ Descartado (26/08/2026) — Kanban de Leads + Agenda já cobriam o mesmo caso de uso; uma aba própria seria redundante. Decisão do usuário, ver §12. |
| **Comunidade** | ✅ Pronto (26/08/2026 — ver §12) |
| **Visão Geral — indicadores** | ✅ Pronto (26/08/2026 — ver §12) — a Agenda já vivia nessa aba, agora os indicadores também |

### Leads (`state.captacao.leads`)

- `LEAD_ETAPAS`: Novo → Em conversa → Negociação → Fechado (final) / Sem
  avanço (final). Kanban com drag-and-drop entre colunas.
- Campos: nome, whatsapp, instagram, origem (`LEAD_ORIGENS` = Indicação,
  Social Selling, **Parceria**, Anúncio, Orgânico, Outro), indicadoPor,
  temperatura (Frio/Morno/Quente), etiquetas (lista editável,
  `state.captacao.etiquetas`), observações.
- Lead visível no mês: sempre, se etapa não é final; se é final, fica preso
  ao mês em que foi finalizado (`mesFinalizado`) — evita "cemitério" no
  quadro, preserva histórico.
- **Fechar um lead vira paciente automaticamente** (`criarPacienteDoLead`).
- Jornada de Lead: mesmo motor da Jornada do Paciente, **sem empurrar pra
  dia útil** (vender em fim de semana é normal, ao contrário do paciente).
  6 modelos padrão (`LEAD_TEMPLATES_DEFAULT`): Lead Quente, Lead Morno, Lead
  Frio, Lead de Indicação, Lead de Social Selling, Nutrição de quem não
  avançou. Cada ação tem canal (`LEAD_CANAIS`: whatsapp, ligação, áudio,
  vídeo, presencial, follow-up, conteúdo, retomada, social, outro).
  Editor de modelos no fim da própria aba Leads (mesmo padrão UI da Jornada
  do Paciente: renomear/duplicar/CRUD de ação).

### Indicações (`state.captacao.indicacoes`)

- `INDICADOR_TIPOS`: Paciente, Lead, **Parceria** (adicionado 26/08/2026),
  Outra pessoa.
- Cadastrar indicação **cria ou vincula** o lead indicado automaticamente
  (busca por WhatsApp/Instagram/nome antes de criar — `acharLeadPorContato`,
  evita duplicata). Se o lead vinculado já estiver "Fechado" no momento do
  cadastro, a indicação já nasce convertida.
- Lead indicado que fecha depois **converte a indicação sozinho**
  (`converterIndicacaoDoLead`), sem ação manual.
- **Marcos de bonificação** configuráveis (`state.captacao.marcos`):
  N indicações CONVERTIDAS → recompensa (cumulativo, nunca zera). Conquistas
  ficam registradas com controle de "entregue/a entregar".
  Placar por indicador (`placarIndicadoresRows` / `indicadorChave`) é
  **genérico por design** — funciona pra qualquer `indicadorTipo`, incluindo
  Parceria, sem precisar tocar nessa função quando um tipo novo é adicionado.

### Agenda de Captação (dentro da aba "Visão Geral")

- Não guarda nada — varre tarefas de jornada de Leads e Parcerias com data,
  não concluídas, não arquivadas. Agrupada por pessoa, por faixa (Atrasado /
  Hoje / Esta semana / Próximos), recolhível. Concluir na Agenda marca a
  MESMA tarefa na origem (não é cópia).
- Comentário no código já deixa preparado: "quando Indicações e Comunidade
  tiverem tarefa com data, é só acrescentar nesta função."

---

## 12. Parcerias, Social Selling e Comunidade (26/08/2026)

### Parcerias — pronto

Seção 08 do artefato "Arquitetura da Captação": **"cultivar parceiro o ano
todo, em vez de lembrar dele só quando falta paciente."**

- **Sem regra de comissão** — nunca foi definida em lugar nenhum do artefato
  original nem em conversa. Se pedirem comissão futuramente, é definição do
  zero, não presumir nada do que já existe.
- **Campos**: nome, WhatsApp, Instagram, tipo/profissão (etiqueta editável —
  `state.captacao.parceriaTipos`, seed: Médico/Academia/Clínica/
  Influenciador, criável na hora pelo próprio modal), estágio, observações.
- **Funil de estágios** (`PARCERIA_ESTAGIOS`): Prospecção → Primeiro contato
  → Ativa → Manutenção (ciclo contínuo) / Inativa (desfecho alternativo,
  final).
- **"Última interação" e "Próxima ação" são calculadas, nunca digitadas** —
  vêm da jornada da parceria (última tarefa concluída / próxima tarefa em
  aberto), mesmo princípio de "não se digita nada" já usado no placar de
  Indicações.
- **Jornada de Parceria**: mesmo motor da Jornada de Lead (cópia adaptada,
  não generalização — `state.captacaoTemplates.parceria`,
  `aplicarJornadaParceria`, `data-parc-task-*`). 4 modelos padrão
  (`PARCERIA_TEMPLATES_DEFAULT`): Nova Parceria, Em Desenvolvimento,
  Manutenção, Reativação, 6 ações cada.
- **Contadores "indicações vieram/fecharam"** por parceria: somados a partir
  de `state.captacao.indicacoes` filtrando `indicadorTipo === 'parceria' &&
  indicadorId === parceria.id` (`parceriaIndicacoesStats`) — não é campo
  manual.
- **Indicações ganhou "Parceria" como tipo de indicador** justamente pra
  esses contadores funcionarem (essa era uma lacuna real entre o artefato e o
  código — identificada e corrigida nesta mesma rodada).
- **Agenda de Captação estendida** pra também ler tarefas de jornada de
  Parceria (mesmo padrão de Leads).
- Editor de modelos de jornada de parceria no fim da própria aba Parcerias
  (mesmo padrão visual dos outros editores de modelo do CRM).
- Testado ponta a ponta com o app inteiro renderizado (ver §2, "app inteiro
  renderizado"): criar parceria, aplicar jornada, concluir tarefa, mudar
  estágio, criar tipo novo, indicação vinda de parceria, conclusão pela
  Agenda — tudo validado sem erro de console.

### Social Selling — descartado (26/08/2026)

Chegou a ser cogitado como próxima sub-aba (visão operacional de Leads
trabalhados por Instagram/WhatsApp), mas na hora de detalhar o escopo o
usuário percebeu que o Kanban de Leads + a Agenda de Captação já cobrem
esse caso de uso (a Agenda já lista as tarefas pendentes de qualquer canal,
incluindo as marcadas com canal "Social Selling"). Uma aba própria seria só
repetir isso com outro nome. **Decisão do usuário**: não construir. A
sub-aba/placeholder foi removida do código (`CAPTACAO_SUBTABS`,
`CAPTACAO_EM_BREVE`). Os campos que já existiam (`origem: 'Social Selling'`
em Lead, `canal: 'social'` em ação de jornada) foram mantidos — são só
classificação, não a tela descartada.

### Comunidade — pronto (26/08/2026)

Cronograma de conteúdos/ações do grupo de WhatsApp e do Instagram
(`state.captacao.comunidade`, array plano — sem motor de jornada, sem
"uma pessoa = um registro", é só uma agenda de itens datados cadastrados
um a um, sem recorrência automática).

- **Modelo de cada item**: canal (`whatsapp`|`instagram`) → tipo dependente
  do canal (WhatsApp: Conteúdo/Post, Desafio interno, Ação presencial —
  Instagram: Reels, Carrossel), data, descrição livre, concluído. Tipos são
  **fixos** (não editáveis pelo usuário, diferente de `parceriaTipos`) —
  confirmado explicitamente, só 5 tipos no total, sem necessidade de criar
  novos na hora.
- **Duas visualizações com toggle**: Lista (agrupada por
  Atrasado/Hoje/Esta semana/Próximos, mesmo padrão da Agenda de Captação,
  com filtro por canal e seção "Mostrar concluídos") e Calendário (grade do
  mês, bolinha colorida por item no dia, clique abre painel do dia com
  "+ Adicionar"). Pedido explícito do usuário — não escolheu um dos dois,
  quis os dois.
- **Entra na Agenda de Captação** junto com Leads e Parcerias, num bloco
  próprio por faixa de prazo (não agrupado por "pessoa", já que Comunidade
  não tem pessoa) — concluir/editar/excluir na Agenda reflete no mesmo
  registro (`bindComunidadeItemActionsIn`, função compartilhada entre a
  aba própria e a Agenda).
- Testado ponta a ponta com o app inteiro renderizado (desktop e mobile
  375px real, com screenshot) — criar item WhatsApp/Instagram, tipo mudando
  por canal, filtro, concluir pela Comunidade e pela Agenda, navegação de
  mês, seleção de dia com prefill de data, exclusão com confirmação — zero
  erro de console, zero overflow horizontal no mobile.

### Visão Geral — indicadores — pronto (26/08/2026)

Última etapa do roteiro da Captação. **Atualizado no mesmo dia**: os
indicadores ganharam seletor de mês próprio (`state.indicadoresMes`,
independente de `state.competencia` — decisão explícita do usuário pra não
misturar com o filtro de Leads/Pacientes) e um modo "Ano"
(`state.indicadoresView`, ver subseção própria abaixo). O texto original
desta seção (comparação sempre mês atual × anterior, `addMonthsToKey(mes,
-1)`) ainda descreve o modo "Mês a mês" — só o campo de referência do mês
mudou de `state.competencia` pra `state.indicadoresMes`.

- **Card Leads**: Entraram no mês (`criadoEm`) com detalhamento por origem
  (Indicação/Social Selling/Parceria/Anúncio/Orgânico/Outro) · Conversas
  iniciadas (`dataConversa`) · Converteram (`etapa==='fechado' &&
  dataFinalizado` no mês) com taxa de conversão (Converteram ÷ Entraram, em
  %) · Sem avanço (`etapa==='sem-avanco' && dataFinalizado` no mês).
  **Confirmado com o usuário**: Converteram/Sem avanço contam no mês em que
  FECHARAM, não no mês em que entraram — são cohorts diferentes de propósito
  (um lead pode entrar em julho e fechar em agosto).
- **Card Parcerias**: Novas parcerias no mês (`criadoEm`) · Ações de
  jornada de parceria concluídas no mês (somando todas as parcerias) como
  proxy de "nutrição". **Decisão explícita**: mostrar só o número bruto,
  sem rotular como "saudável/não saudável" — isso exigiria inventar um
  limiar que ninguém definiu (nunca fazer isso sem pedido explícito).
- **Sem card próprio de Indicações**: o detalhamento por origem do card de
  Leads já cobre isso (mostra "Indicação: X"). O usuário cogitou uma
  automação maior (ligar o cadastro de Lead ao placar formal de
  Indicações) mas isso ficou anotado como tarefa separada, fora do escopo
  desta etapa — ver task_4e06ccf9 (chip spawnado 26/08/2026, ainda não
  iniciado; se já tiver sido feito, esta nota está desatualizada).
- **Datas do Lead agora editáveis** (pedido explícito do usuário, pra
  poder cadastrar leads antigos/históricos com a data real, não a de hoje):
  `criadoEm` (data de entrada), `dataConversa` (novo campo — grava sozinho
  na primeira vez que a etapa sai de "Novo"), `dataFinalizado` (já existia,
  grava sozinho ao virar Fechado/Sem avanço). Os três têm auto-preenchimento
  ao vivo no formulário (listener no `#l_etapa`) mas são 100% editáveis —
  automação por padrão, correção manual sempre possível. `mesFinalizado`
  (usado pra visibilidade no Kanban por mês) passou a ser derivado de
  `dataFinalizado.slice(0,7)` no fluxo do formulário, em vez de sempre usar
  `state.competencia` — mais preciso pra backfill de leads antigos. O
  drag-and-drop do Kanban (`moverLeadParaEtapa`) não foi tocado, continua
  como estava.
- Testado com dados fake variados (dois meses, várias origens, parcerias
  com ações concluídas) — cada número validado manualmente contra o
  esperado, incluindo o efeito de editar `dataFinalizado` pra um mês
  anterior e ver os indicadores recalcularem. Mobile 375px validado via
  técnica de iframe (ver §2, metodologia de teste) depois que a emulação
  de viewport do painel de teste ficou instável numa sessão — encontrou e
  corrigiu um bug real: os blocos de estatística (Conversas
  iniciadas/Converteram/Sem avanço) empilhavam um por linha em vez de
  ficar lado a lado por falta de `min-width` nos itens do flex — corrigido
  com `flex:1 1 128px;min-width:128px`.

### Visão Geral — gráficos, seletor de mês e modo Ano (26/08/2026)

Pedido do usuário pra deixar os indicadores mais visuais (os números
sozinhos "ficaram muito baseados em números e pouco visuais"). **Nada dos
cálculos existentes foi alterado** — os gráficos só desenham em cima de
`leadsStatsDoMes`/`parceriasStatsDoMes`, sem lógica paralela.

- **Gráfico de barras mês atual × anterior** (`indComparisonChartHtml`):
  reaproveita o mesmo truque visual do `.monthly-trend-fill` do Dashboard
  — 1 cor só (`--primary`), opacidade cheia pro mês atual e reduzida
  (`.4`) pro anterior, em vez de duas cores diferentes. Um pra Leads (4
  métricas), outro pra Parcerias (2 métricas), dentro dos cards que já
  existiam.
- **Funil de Conversão de Leads** (`indFunnelHtml`): 3 barras decrescentes
  (Entraram → Conversas iniciadas → Converteram), com % de retenção entre
  etapas. **Importante**: os 3 números vêm de datas diferentes por
  desenho (criadoEm/dataConversa/dataFinalizado), então não é
  necessariamente o mesmo grupo de pessoas de ponta a ponta (um lead pode
  ter "convertido" esse mês tendo "entrado" num mês anterior) — o rótulo
  do drop usa "% da etapa anterior" (não "% que avançou") de propósito,
  pra não alegar um funil de coorte estrito que os dados não garantem.
- **Seletor de mês próprio da Visão Geral** (`state.indicadoresMes`,
  `indicadoresMesSelect`): independente de `state.competencia`. Decisão
  explícita do usuário — trocar o mês aqui não deve mexer em Leads/
  Pacientes. Sempre abre no mês atual comparando com o anterior por
  padrão (`state.indicadoresMes` inicializado com `getCurrentMonthKey()`
  na primeira renderização).
- **Toggle "Mês a mês" / "Ano"** (`state.indicadoresView`): no modo Ano
  (`captacaoIndicadoresAnoHtml`), mostra o acumulado de Janeiro até o mês
  atual (`monthsYTD()`, ano sempre calculado via `new Date().getFullYear()`
  — nunca hardcoded 2026) via `leadsStatsAcumulado`/
  `parceriasStatsAcumulado` (somam os mesmos `leadsStatsDoMes`/
  `parceriasStatsDoMes` mês a mês, sem recalcular nada do zero), mais um
  gráfico com todos os meses do ano lado a lado por métrica
  (`indYearMetricsGridHtml`/`indYearTrendChartHtml` — visual idêntico ao
  `monthlyTrendChartHtml` do Dashboard, mas **sem** o clique de
  drill-down: os botões de drill do Dashboard (`data-trend-drill-*`) só
  têm handler quando a aba Dashboard está montada, então reaproveitar o
  componente original teria deixado botões "mortos" na Visão Geral — por
  isso existe uma versão própria, não interativa, com as mesmas classes
  CSS). Modo Ano não compara com período anterior (não existe 2025 com
  dados nesse CRM ainda).
- Testado: seletor de mês trocando sem afetar a competência de Leads
  (conferido nos dois sentidos), modo Ano com soma manual conferida mês a
  mês contra o resultado, mobile 375px real (iframe) e desktop nos dois
  modos, zero erro de console, zero regressão em Leads/Agenda/Dashboard.

---

## 13. Polimentos de Sidebar, Leads e Pacientes (27-28/08/2026)

Sequência de pedidos pequenos e pontuais, cada um implementado, testado
(desktop + mobile 375px) e publicado isoladamente, sem afetar os outros.

### Botão de recolher/expandir a sidebar (commit `163bf5e`)

Reposicionado de dentro da sidebar pra uma aba fixa grudada na borda
(`.sidebar-edge-toggle`), com seta `‹`/`›` conforme o estado, funcionando
igual em desktop (`sidebarCollapsed`) e mobile (`drawer-open`).
**Bug encontrado e corrigido nesta mesma rodada**: a regra
`.sidebar.collapsed ~ .sidebar-edge-toggle{left:62px;}` não estava só
dentro do media query de desktop, então vazava pro mobile quando
`sidebarCollapsed` ficava `true` (de um toggle anterior em contexto
desktop) enquanto `drawer-open` estava `false` — corrigido com um override
dentro de `@media(max-width:600px)` que força `left:0` sempre, deixando só
`.drawer-open` valer no mobile.

### Menu Captação recolhido por padrão + confirmação no modal de Lead (commit `c22bf17`)

- O grupo "Captação" da sidebar agora **abre recolhido por padrão** — só
  expande/recolhe pelo próprio clique nele, não pela navegação entre
  sub-abas.
- Modal de **Editar/Novo Lead** ganhou a mesma proteção de "tem certeza que
  quer sair sem salvar?" que o modal de Editar Paciente já tinha —
  reaproveitando a lógica/diálogo existente, não uma nova implementação.

### Lead Fechado → cadastro de Paciente pré-preenchido (commit `8d1baad`)

**Redesenho de um comportamento que já existia** (`criarPacienteDoLead`
criava o paciente sozinho, em segundo plano, silenciosamente, assim que o
Lead virava "Fechado"). O usuário não queria isso — quis revisar/completar
os dados antes de o paciente existir de verdade. Novo fluxo
(`abrirCadastroPacienteDoLead(lead)`):

- Ao mover um Lead pra "Fechado" (Kanban drag-and-drop `moverLeadParaEtapa`
  ou salvar o modal do Lead na etapa Fechado), abre o formulário real de
  **Novo Paciente**, pré-preenchido com nome/WhatsApp/Instagram do Lead.
- O paciente só é criado de verdade quando o usuário clica **Salvar** no
  formulário — não existe mais criação silenciosa.
- Se o usuário fechar/cancelar o formulário sem salvar, o Lead continua
  "Fechado" mas sem paciente vinculado — um banner no modal do Lead
  (`leadCompletarPacienteBtn`, terceiro estado do banner "vínculo") oferece
  **retomar** o cadastro depois, a qualquer momento.
- Ao salvar, o handler de salvar Paciente lê `state.leadParaConverter` e
  vincula os dois registros (`patient.leadId` / `lead.pacienteId`), com um
  toast de sucesso próprio.
- **Bug pré-existente encontrado e corrigido durante o teste desta feature**
  (não causado por ela): o botão "Abrir o cadastro" do Lead chamava
  `openProfile(pid)`, função que não existe — corrigido pra
  `openProfileModal(pid)`. Reportado como correção bônus por estar
  diretamente na cadeia testada.

### Ícones reais de WhatsApp/Instagram (commit `e58ebd6`)

Emojis 💬/📷 trocados por ícones SVG reais da marca (`whatsappIcon()` /
`instagramIcon()`) em **todo lugar clicável como link**: cards de Lead,
modal de Lead, modal de Parceria, Agenda de Captação, telefone no Perfil
do Paciente. **Não trocado** em rótulos puros de categoria/tipo (onde o
emoji só identifica um canal, sem ser link) — distinção pedida
explicitamente pelo usuário.
**Falso alarme já resolvido**: o usuário reportou que os ícones "não
estavam no ar" — era confusão dele mesmo (cache/aba antiga); confirmado
via `gh api`/`curl` direto no site publicado que os ícones já estavam lá.

### Aba Pacientes: estados padrão invertidos (commit `e4de626`)

Dentro da aba Pacientes: a seção **Visão Geral** (tabela semanal de
Engajamento/Check-in) agora abre **expandida** por padrão, e a seção
**Pacientes** (tabela principal de cadastro) agora abre **recolhida** por
padrão — inverteu o que era antes. Só o estado inicial de abertura mudou,
nenhuma lógica de filtro/busca/conteúdo das duas seções foi tocada.

---

## 14. Financeiro (commit `3b5eab0`, 28/08/2026)

Aba nova, item de topo próprio na sidebar (logo abaixo de Captação, não
dentro dela). Planejada com o usuário numa fase explícita de "não
implemente ainda" antes de codar, com decisões de negócio confirmadas via
`AskUserQuestion` antes de escrever qualquer linha.

### Modelo de dados (`crmData/financeiro`, mesmo padrão de `captacao`)

```
financeiro = {
  lancamentos: [ {
    id, tipo: 'entrada' | 'saida',
    categoria,           // lista editável, própria (não reaproveita parceriaTipos)
    descricao,
    data,
    formaPagamento,      // lista editável
    valorBruto, valorLiquido,   // digitados os DOIS manualmente, por lançamento
    pacienteId            // opcional, vínculo informativo, não obrigatório
  } ]
}
```

### Decisões de negócio confirmadas com o usuário

- **Bruto e líquido são digitados manualmente por lançamento**, não
  calculados automaticamente por uma taxa fixa (%) — decisão explícita:
  taxas de maquininha/plataforma variam por lançamento real, uma % fixa
  erraria.
- **Categorias e formas de pagamento são listas editáveis** (mesmo padrão
  de `parceriaTipos`: select + "criar nova" na hora), não fixas.
- Comparação mês a mês (gráficos, mesmo padrão visual dos gráficos da
  Visão Geral da Captação — ver §12) e seletor de mês **independente** dos
  outros seletores do CRM (`state.financeiroMes`), com toggle **Mês/Ano**
  igual ao da Visão Geral.
- Tabela de lançamentos filtrável/buscável (tipo, categoria, forma de
  pagamento, busca por texto) e recolhível
  (`state.financeiroTableCollapsed`).
- Componentes de gráfico genéricos já existentes (`indComparisonChartHtml`,
  `indYearTrendChartHtml`, `indYearMetricsGridHtml`, `deltaLabelHtml`)
  foram **estendidos com um parâmetro `formatFn` opcional** pra suportar
  formatação de moeda sem quebrar os usos antigos (não-monetários) —
  retrocompatível, não duplicou os componentes. `deltaLabelHtml` também
  ganhou uma opção `invertido` pra métricas onde "subir" é ruim (ex:
  saídas).
- Nova função utilitária `formatMoney(v)` (perto de `esc`/`clamp`).
- Testado ponta a ponta com o app inteiro renderizado, dados fake variados
  (entradas/saídas em dois meses, categorias diferentes), desktop e mobile
  375px real — publicado.

---

## 15. Modo Escuro / Tema (commit `7ffeafb`, 28/08/2026)

Alternância clara/escura completa, pedida com especificação detalhada de
posição e persistência pelo usuário (com duas imagens de referência de um
switch sol/lua em pílula).

### Requisitos confirmados pelo usuário (não renegociar sem pedir)

- **Não fica escondido em Configurações** — botão **sempre visível**.
- **Posição fixa**: canto superior direito da **tela** (`position:fixed`),
  não rola com a página, não é por aba, não esbarra em nenhum outro botão
  de nível de página. No celular, fica **dentro da barra preta do topo**
  (a mesma que mostra "Angelo Garcia CRM").
  Mesmo local sempre, clicando em qualquer tela do CRM.
- **Ícone**: pílula sol/lua, conforme as duas imagens de referência
  enviadas (claro = sol em destaque; escuro = lua em destaque).
- **Persistência**: `localStorage`, guarda só a **última escolha**
  (sobrevive a reload e a reabrir o CRM). Explicitamente **não é o mesmo
  mecanismo** usado pra lembrar o estado de recolher/expandir a sidebar
  (aquilo não persiste entre sessões, o tema sim).
- **Preservar a identidade visual** — cores de marca/destaque (ex:
  laranja de "ficha vigente", azul de "Atual", vermelho de risco/vencido)
  continuam as mesmas nos dois modos. É uma versão escura literal do
  mesmo design, **não um redesenho**.

### Arquitetura de cores (verificada antes de implementar, por pedido explícito)

- Bloco `:root{...}` no `<style>` já centralizava as cores em variáveis
  CSS — base reaproveitada, sem duplicar sistema de cores.
- Modo escuro implementado como bloco de override
  `html[data-theme="dark"]{...}` logo depois do `:root`, redefinindo as
  mesmas variáveis (não uma folha de estilo paralela).
- **Estado do tema não vive em `state`** (não é dado de negócio) — vive só
  no atributo `data-theme` do `<html>` + `localStorage`
  (`THEME_STORAGE_KEY`). Funções novas: `getTheme()`, `applyTheme(theme)`,
  `toggleTheme()`, `themeToggleHtml()` (perto de `instagramIcon()`).

### Bugs encontrados e corrigidos durante a auditoria de cores (antes de virarem bug visível)

- **`--white` tinha dois sentidos misturados**: ~44 usos como
  `background:var(--white)` significando "superfície/cartão" (esses viram
  `var(--surface)` no escuro) contra 3 usos como cor de contraste literal
  (ex: `.jornada-cal-cell.selected .jornada-cal-dot`, um ponto branco
  dentro de uma célula já colorida com a cor primária — esse **continua**
  `var(--white)` mesmo no escuro). Um `sed` em massa trocando tudo
  corrompeu momentaneamente esse caso; corrigido manualmente antes de
  seguir.
- **Substituições em massa de cor hardcoded (`#F4F5F7`, `#FAFAFA` etc.)
  quase reescreveram as próprias definições de variável** em `:root`
  (ex: `--bg:#F4F5F7` virando `--bg:var(--bg)`, auto-referência inválida),
  já que a definição contém o mesmo hex usado nos lugares que a
  referenciam. Corrigido restaurando os valores literais nas linhas de
  definição; substituições seguintes passaram a usar padrões com prefixo
  (ex: `border-color:#FCA5A5` em vez do hex solto) especificamente pra não
  tocar `:root` de novo.
- **`.meta-box` tinha contraste só pra modo claro**: `border`/`color`
  hardcoded (`#FDBA74`/`#9A3412`) mais dois `style` inline em botões
  gerados via JS. Corrigido com variáveis novas `--meta-border`/
  `--meta-text` e removendo os inline styles pra a classe CSS valer.

### Superfícies cobertas (testadas em ambos os modos, desktop + mobile 375px)

Fundos, sidebar, cards, texto, campos de formulário, modais, tabelas,
gráficos, menus/popovers de filtro, botões — em todas as abas (Pacientes,
Dashboard, Jornada, Captação completa, Financeiro).

---

## 16. Ícone da logo pra "adicionar à tela de início" (PWA) — CONCLUÍDO 28/08/2026

- **Pedido**: usar a logomarca já usada no CRM (`LOGO_DATA_URI`, PNG
  169×169 base64 embutido, usado em `.login-logo` e `.logo-box`) como
  ícone quando o CRM for adicionado à tela de início do celular
  (iOS/Android).
- **Bloqueio anterior** (colar direto no chat não gera arquivo acessível)
  foi contornado: um arquivo `logo.png` (mesma imagem, 169×169) de uma
  tentativa anterior tinha ficado salvo no diretório de scratchpad de uma
  sessão passada e foi localizado e reaproveitado. O usuário confirmou
  que essa é a melhor resolução que ele tem disponível — ciente de que o
  ícone final não é nítido em telas grandes por ser upscale de uma imagem
  pequena.
- **O que foi implementado**:
  - `icons/icon-192.png`, `icons/icon-512.png`, `icons/apple-touch-icon.png`
    (180×180), `icons/favicon-32.png`, `icons/favicon-16.png` — todos
    gerados via upscale bicúbico (PowerShell `System.Drawing`) a partir da
    logo 169×169 existente.
  - `manifest.json` na raiz do projeto (name "AGCentral CRM", theme_color
    `#EA580C` igual ao `--primary` do CRM, display `standalone`).
  - `<head>` do `index.html` recebeu `<link rel="manifest">`, ícones de
    favicon/apple-touch-icon e metas `theme-color` /
    `apple-mobile-web-app-*`.
  - **Nada dentro do CRM em si foi alterado** (login, `.logo-box`,
    `LOGO_DATA_URI` continuam como estavam) — só arquivos novos e o
    `<head>`.
- Testado localmente (servidor estático via `.claude/launch.json`
  temporário, removido depois): manifest e todos os ícones respondem 200
  `image/png`/`application/json`, sem erros de console, testado em
  desktop e mobile 375px.
- **Se o Ângelo mandar futuramente uma versão em alta resolução de
  verdade**, é só regenerar os arquivos em `icons/` a partir dela
  (mesmo processo de upscale, ou direto se já vier grande) — não precisa
  reabrir manifest/head, só substituir os PNGs.
- **Ajuste 28/08/2026**: o fundo transparente ao redor do círculo gerava
  fundo branco no ícone (padrão de várias telas/OS pra PNG transparente).
  Ícones regenerados com fundo **preto** sólido (composto na hora do
  upscale). `manifest.json` `background_color` também mudado de `#ffffff`
  pra `#000000` (cor da splash screen ao abrir o PWA).

---

## 17. Dúvidas / decisões em aberto pra revisitar

- **Comissão de Parceria**: não definida. Perguntar antes de qualquer coisa
  relacionada a valor monetário de parceria.
- **NPS tracking**: cogitado bem no início (inspirado na planilha original),
  nunca pedido de verdade — não construir sem pedido explícito.
- Doc antigo de deploy (memória `reference-crm-deployment`) menciona
  localStorage como base de dados — **está desatualizado**, hoje é Firebase
  (ver §2). Se reler memórias antigas, desconfiar de qualquer menção a
  localStorage como fonte de dados viva.

---

## 18. Histórico condensado (linha do tempo por marcos, não exaustivo)

Pra detalhe fino de qualquer marco específico, `git log --oneline` no repo
tem a lista completa e datada de commits — cada mensagem já é descritiva o
suficiente pra entender o que mudou. Marcos grandes, em ordem:

1. CRM inicial (cadastro, fichas de treino/dieta) — localStorage.
2. Dashboard com KPIs calculados, Pacientes em Risco, Aniversariantes,
   Inativos, filtros por coluna.
3. Jornada do Paciente — 3 reconstruções sucessivas até chegar no formato
   atual (Kanban por paciente, arquivo estilo Trello, modelos editáveis,
   seleção de jornada independente de Plano/Serviço).
4. WhatsApp/e-mail/nascimento no cadastro, aniversariantes.
5. Autenticação de dois fatores (TOTP).
6. **Migração completa pra Firebase** (Firestore + Auth) — saiu de
   localStorage.
7. Ficha de dieta: g/kg, distribuição de macros, ciclo de carboidrato,
   calorias/refeição livre.
8. Adaptação mobile completa (celular vira layout de cartões).
9. Plano quinzenal pra "só Treino"; depois planos Essencial (mensal, sem
   engajamento).
10. Correções de peso (slot livre, merge ao salvar, Enter pra salvar,
    paginação, excluir com confirmação).
11. Sidebar recolhível + grupo Captação criado (placeholders).
12. **Captação**: Leads → Jornada de Lead → Agenda → Indicações →
    **Parcerias** → Comunidade → Visão Geral com indicadores/gráficos (nesta
    ordem, cada etapa "entrando no ar funcionando" antes da próxima).
    Social Selling cogitado e descartado no meio do caminho (§12).
13. Vários polimentos visuais e de UX ao longo de todo o processo (bordas de
    destaque, cores de badge, remoção de textos redundantes, busca
    flexível, correções de clique duplo).
14. Botão de recolher/expandir a sidebar reposicionado como aba fixa na
    borda (‹/›); menu Captação passou a abrir recolhido por padrão; modal de
    Lead ganhou confirmação ao tentar sair sem salvar (mesma lógica já usada
    em Editar Paciente) — ver §13.
15. **Lead Fechado abre automaticamente o cadastro de Novo Paciente
    pré-preenchido** (não cria mais o paciente sozinho em segundo plano) —
    ver §13.
16. Emojis de WhatsApp/Instagram trocados por ícones SVG reais da marca em
    todo lugar clicável (cards de Lead, modal de Lead, modal de Parceria,
    Agenda de Captação, telefone do Perfil do Paciente) — ver §13.
17. Aba Pacientes: estado padrão de abertura invertido — Visão Geral
    (Engajamento/Check-in) abre expandida, tabela de Pacientes abre
    recolhida — ver §13.
18. **Nova aba Financeiro**: entradas/saídas, bruto/líquido por lançamento,
    categorias editáveis, forma de pagamento, comparação mês a mês,
    seletor de mês independente, toggle Mês/Ano — ver §14.
19. **Modo escuro completo**: alternância sol/lua fixa no canto superior
    direito, aplicado em todo o CRM preservando as cores de marca — ver §15.

---

## 19. Listagem de "Pacientes" removida — Dashboard "Pacientes Ativos" virou a lista principal (28/08/2026)

A aba **Pacientes** tinha uma listagem própria (Nome/Plano/Prioridade/Status +
botões Ver/Editar/Excluir) redundante com o card "Pacientes Ativos" do
Dashboard. Removida a pedido do Ângelo — dentro de "Pacientes" agora só
existem **Visão Geral** e **Material Pós-Consulta Pendente** (mais o toolbar
com Competência, + Novo Paciente, Exportar, Importar — tudo preservado,
nada dessas ações dependia da listagem removida).

- O card **"Pacientes Ativos"** do Dashboard, ao ser clicado, agora abre a
  tabela principal de pacientes ativos com busca por nome, ordenação por
  Nome e Vencimento, e filtro por Plano/Prioridade/Status/Status Consulta —
  reaproveitando 100% o motor antigo (`filteredPatients()`, `comparePatients`,
  `filterThHtml`/`applyFilterSelection`, os mesmos `state.sortBy` /
  `state.sortDir` / `state.planoFilter` / `state.prioridadeFilter` /
  `state.statusFilter` que a listagem antiga já usava — ficaram "livres" pra
  reaproveitar assim que a listagem foi removida). Novo campo
  `state.consultaFilter` pro filtro de Status Consulta (Em dia/Próximo/
  Atrasado/Sem data), que essa tabela não tinha antes.
- **Sem botões de Ver/Editar/Excluir** nessa tabela (pedido explícito) — o
  nome do paciente é clicável e abre o perfil, onde editar/excluir já
  existem.
- **Regra de ordenação por Vencimento**: crescente = quem vence primeiro
  aparece primeiro (data mais próxima no topo); clique de novo inverte.
- **Regra do filtro de Status Consulta** (definida pelo Ângelo nessa
  conversa): ao selecionar um status de consulta específico (ex: "Próximo"),
  a lista SEMPRE ordena por urgência — menos dias até a consulta primeiro
  (ex: consulta em 3 dias antes de consulta em 5 dias), independente da
  coluna de ordenação (Nome/Vencimento) que estava ativa antes. Só passa a
  valer enquanto o filtro de Status Consulta não for "Todos".
- Funções/estado removidos por ficarem órfãos: `patientRowTemplate`,
  `renderPatientRows`, `refreshPatientsTable`, `bindRowActions`,
  `MAIN_TABLE_FILTER_KEYS`. `dashboardFilterPatients`/`dashboardFilterRows`
  continuam existindo e intactos pros outros cards (Vencendo, Consulta
  Próxima, Renovação Próxima/Antecipada, Inativos, Aniversariantes,
  Fichas de Treino) — só "Pacientes Ativos" ganhou a tabela nova.

---

## 20. Paginação genérica de 10 por página (28/08/2026)

Reaproveitada a mesma lógica/visual do paginador do histórico de peso
(`.peso-history-pager`, 5 por página — **esse continua intocado**) numa
versão genérica com tamanho configurável, em `paginateList(list, pageKey,
pageSize)` + `listPagerHtml(pageKey, page, totalPages)` +
`listPagerGoPrev`/`listPagerGoNext` ([index.html](index.html)). Cada lista
paginada guarda sua página atual em `state.listPage[pageKey]`, sempre
reclampada pro intervalo válido a cada render — a mesma auto-correção que
já existia só pro peso, então filtro/busca/troca de mês nunca deixam a
página "presa" vazia.

Aplicado com **10 por página** em:
- **Dashboard > Pacientes em Risco** (`pageKey: 'risco'`) — o número no
  título da seção continua sendo o total real, não o da página.
- **Dashboard > Acesso Rápido**, cada bloco com paginação independente:
  Sem Atualização Recente Treino (`qaTreino`), Vencimentos (`qaVenc`), Sem
  Atualização Recente Dieta (`qaDieta`), Sem Consulta Marcada
  (`qaConsulta`), Sem Vigência (`qaVigencia`), Resumo de Entrega de
  Paciente (`qaResumoEntrega`).
- **Pacientes > Visão Geral** (`pageKey: 'overview'`) — pager num
  `<div id="overviewPagerWrap">` próprio, atualizado junto com o tbody
  (`#overviewTableBody`) em `refreshOverviewTable()` sempre que busca,
  filtro (Status Consulta/Média), ordenação por Nome ou troca de
  competência mudam os resultados.
- As funções de linhas do Acesso Rápido (`semAtualizacaoRows`,
  `vencimentosQuickRows`, `semConsultaMarcadaRows`, `semVigenciaRows`,
  `resumoEntregaRows`) passaram a retornar `{ rowsHtml, pagerHtml }` em vez
  de só a string das linhas — único jeito de expor a paginação sem duplicar
  a lógica de busca/ordenação que cada uma já tinha.
