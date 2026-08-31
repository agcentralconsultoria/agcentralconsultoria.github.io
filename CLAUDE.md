# CRM Angelo Garcia — CLAUDE.md

Guia rápido e permanente para trabalhar neste projeto. Para histórico detalhado,
decisões passadas, regras de negócio completas e o roteiro de desenvolvimento,
**consulte sempre `CRM_CONTEXT_BACKUP.md`** — este arquivo aqui é só o essencial do
dia a dia; aquele é a fonte completa.

## O que é este projeto

CRM de gestão de pacientes para o Angelo Garcia (treinador/nutricionista), usado
também por sua colaboradora Débora. Um único arquivo `index.html` (~630KB+, vanilla
JS/HTML/CSS, sem build, sem framework) contendo cadastro de pacientes, fichas de
treino/dieta, check-ins semanais, Dashboard, Jornada (funil de tarefas/kanban), a
área de Captação (Leads, Parcerias, Indicações, Comunidade, Instagram, Visão
Geral — completa, ver `CRM_CONTEXT_BACKUP.md` §11/§12/§21), a aba **Financeiro** (entradas/saídas,
bruto/líquido, comparativos mensais — ver §14) e um **modo escuro** completo com
alternância sol/lua fixa no canto superior direito (ver §15).

## Stack e deploy

- **Sem build step.** É um `index.html` só, editado direto.
- **Persistência:** Firebase (Firestore + Authentication, SDK modular). Documentos
  principais no Firestore: `crmData/patients`, `crmData/captacao`,
  `crmData/captacaoTemplates`, `crmData/jornadaTemplates`, `crmData/grupoMuscularList`.
- **Deploy:** GitHub Pages, repositório da organização
  `agcentralconsultoria/agcentralconsultoria.github.io`, branch `main`.
  `git push origin main` já publica (não precisa de mais nada). Domínio customizado
  configurado via `CNAME`. Build do Pages leva ~15-30s pra ficar `built`.
- **`.nojekyll`** presente de propósito — sem ele o GitHub Pages tenta processar
  como Jekyll e quebra/atrasa a publicação.

## Quem é o usuário

Ângelo — treinador/nutricionista, **não-técnico**. Toda comunicação em **PT-BR**,
direta, sem jargão técnico. Plano Claude Pro (efficiency baixo/moderado importa —
veja seção de token abaixo).

## Regras fixas (não negociáveis, já confirmadas pelo usuário)

1. **Mobile sempre.** Todo ajuste visual precisa funcionar em celular. Teste
   sempre em viewport 375px (mobile) além do desktop, antes de dar como pronto.
2. **Escopo cirúrgico.** Quando o usuário disser "faça somente essa alteração" —
   e ele diz isso quase sempre — não refatore, não "aproveite pra melhorar" outra
   coisa, não mude comportamento de partes que já funcionam. Se notar algo que
   merece atenção fora do escopo, avise mas não implemente sem pedir.
3. **Teste antes de dizer que terminou.** Nunca declare uma correção pronta sem
   validar. Ver metodologia de teste abaixo.
4. **Pergunte antes de assumir regra de negócio.** Quando uma tarefa envolve
   decisão de negócio ambígua (ex: qual critério de risco, o que conta como
   "novo registro", que dado é fonte de verdade), pergunte objetivamente em vez
   de supor. O usuário prefere isso a retrabalho.
5. **Nunca invente regra que não foi definida.** Se o histórico/arquitetura não
   define algo (ex: comissão de Parcerias nunca foi definida), diga isso
   explicitamente em vez de preencher a lacuna sozinho.
6. **Eficiência de token importa.** Ângelo está no plano Pro; evite gastar tokens
   à toa (over-explaining, re-leitura desnecessária, implementar sem confirmar
   escopo). Prefira respostas curtas e diretas fora de código.
7. **Sessão/semana com token baixo (~15% ou menos): não comece uma feature
   grande nova** (ex: uma área inteira nova da Captação). Avise isso
   explicitamente e sugira fechar num ponto limpo (já commitado e publicado)
   em vez de arriscar ficar pela metade — ele depende do CRM publicado pra
   trabalhar todo dia e tem medo real de ficar "no meio" de algo. O risco real
   nunca é o site quebrar (só se dá push depois de testar tudo), só o ritmo de
   entrega.
8. **Publicar sozinho assim que testar (regra dada 26/08/2026).** Depois de
   testar uma mudança (desktop **e** mobile 375px) e estar tudo OK, faça
   `commit` + `git push origin main` direto — **não pergunte "posso
   publicar?"** a cada vez. Mobile funcionando faz parte da definição de
   "pronto", não é um passo à parte. Só segure a publicação se um teste
   realmente falhar ou se sobrar uma decisão que só ele pode tomar.

## Metodologia de teste usada neste projeto

Como é um app protegido por login Firebase (não dá pra logar automaticamente por
política de segurança — nunca digitar senha em nome do usuário), a forma
estabelecida de testar mudanças é:

1. Extrair as funções reais do `index.html` (copiadas *verbatim*, sem reescrever)
   e o CSS real (`sed -n '/^<style>/,/^<\/style>/p' index.html`) para um HTML de
   teste isolado no diretório de scratchpad.
2. Servir esse HTML com um pequeno servidor PowerShell
   (`System.Net.HttpListener`) via `.claude/launch.json` + `preview_start`, já
   que `file://` tem limitações de CORS/fetch.
3. Interagir de verdade pelo Browser pane (cliques reais, não só
   `dispatchEvent` sintético — cliques sintéticos não reproduzem certas
   nuances de foco/click do navegador).
4. Testar em mobile (375px, `resize_window` preset mobile) e reset pra desktop
   no fim. **Se o preset mobile não aplicar de verdade** (viewport continua
   ~980px), não insistir — usar o fallback de iframe 375px documentado em
   `CRM_CONTEXT_BACKUP.md` §2 (item 4).
5. Para testar o **app inteiro renderizado** (não só uma função isolada), dá pra
   pegar o `<script>` inteiro do `index.html`, trocar o `init()` final por um
   bootstrap que popula `state` com dados fake e pula o Firebase (stub de `mfa`
   com `setDoc`/`getDoc` no-op), e servir com os 4 elementos-raiz que o app
   espera: `#app`, `#modal-root`, `#toast-root`, `#chart-expand-root`.
6. Sempre `rm -rf .claude` do projeto real antes de commitar (é só infraestrutura
   de teste, não deve ir pro repo).
7. Verificar sintaxe do arquivo completo com `new Function(code)` no browser
   quando a mudança for grande/estrutural (pega erro de chave/parêntese sem
   precisar Node, que não está disponível neste ambiente Windows).

## Onde procurar o quê

- Toda a lógica de negócio e render está em UM `<script>` (IIFE) dentro do
  `index.html`. Não há módulos separados.
- `state` é o objeto global de estado da UI (não persistido — o que é
  persistido vive em `state.patients`, `state.captacao`, `state.captacaoTemplates`
  etc., sincronizados com Firestore via `save*()`/`load*Async()`).
- Padrão de nomenclatura: `functionNameHtml()` gera HTML; `bindXEvents()` liga
  os listeners depois do render; `refreshX()` re-renderiza uma parte específica
  chamando as duas.
- Reaproveitamento é a norma: quando uma funcionalidade nova é parecida com uma
  existente (ex: Parcerias reaproveitando o motor de Jornada de Lead), a
  abordagem preferida é copiar-e-adaptar com nomes próprios (não generalizar a
  função original), pra não arriscar regressão no que já funciona.

## Pendência em aberto

Nenhuma no momento. PWA/ícone de tela inicial concluído em 28/08/2026 (ver
`CRM_CONTEXT_BACKUP.md` §16) — `manifest.json` + `icons/` na raiz, linkados no
`<head>` do `index.html`. Logo fonte usada era só 169x169 (a única disponível),
upscalada pra 192/512/180/32/16; se o Ângelo mandar uma versão em alta
resolução no futuro, é só regenerar os ícones a partir dela.

## Arquivos deste diretório

- `index.html` — o CRM inteiro.
- `manifest.json` — manifest do PWA (ícone de tela inicial).
- `icons/` — ícones gerados a partir da logomarca (192, 512, apple-touch-icon,
  favicons).
- `CLAUDE.md` — este arquivo.
- `CRM_CONTEXT_BACKUP.md` — histórico completo, decisões, regras de negócio,
  roteiro de desenvolvimento e estágio atual de cada parte. **Leia antes de
  qualquer tarefa de porte médio/grande, ou sempre que precisar recuperar uma
  decisão anterior.**
