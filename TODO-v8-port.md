# TODO — V8 port follow-ups

## Plate solving desabilitado no porte V8 — requer trabalho conjunto watcher + Node

**Status:** desabilitado (Opção A) durante o porte do watcher para o runtime V8
(PixInsight 1.9.4 Lockhart). Branch: `v8-port`.

### Contexto

Ao portar `pjsr/pixinsight-mcp-watcher.js` para V8, o `#include` do ImageSolver
foi **removido** do watcher (Opção A), junto com as 6 dependências AdP e os
defines que só serviam ao solver. Motivos:

1. **A cópia incluída não carrega sob V8.** O watcher incluía
   `/Applications/PixInsight/src/scripts/AdP/ImageSolver.js` (versão 6.3.1, 2024),
   que **não está portada** (sem `#engine`, sem `ensureMinimumVersion`) e tem um
   `let toolTip` **declarado duas vezes no mesmo escopo** (linhas ~868 e ~991) —
   ilegal em V8/ES2025 (`SyntaxError: Identifier 'toolTip' has already been
   declared`), embora tolerado pelo SpiderMonkey antigo. É arquivo de sistema
   (`/Applications/PixInsight/...`), que **não pode ser editado**.
2. **Nenhum handler do watcher usava o solver.** Os 17 tools registrados no
   `dispatchCommand` não referenciam ImageSolver/plate solving. O include era
   peso morto no carregamento.

### Problema de fundo (o motivo de precisar de trabalho no Node também)

O único consumidor dinâmico do ImageSolver é o `eval` enviado pelo lado Node em
`agents/llm/deterministic-prep.mjs` (~linhas 449–483), via comando `run_script`.
Esse código chama o ImageSolver **como se fosse um PROCESSO**:

```js
var P = new ImageSolver;
P.centerRA = ra;
P.centerDec = dec;
P.pixelSize = pixSize;
P.focalLength = focal;
P.resolution = pixScale;
P.autoFlip = true;
P.catalogMode = 1;
P.catalog = 'GaiaDR3';
P.limitMagnitude = 14;
P.distortionCorrection = true;
P.projectionSystem = ImageSolver.prototype.Gnomonic;
P.executeOn(w.mainView);
```

Mas o `ImageSolver` do script é um **ENGINE**, não um processo:

- Cópia antiga (AdP 6.3.1): `function ImageSolver()` com `this.Init(window, …)` e
  `this.SolveImage(targetWindow)`.
- Cópia portada (`src/scripts/ImageSolver/ImageSolver.js`, v6.4.2): `var
  ImageSolver = class { … }` com `this.solverCfg`, `this.metadata`,
  `SolveImage(...)`.

Nenhuma versão tem `.executeOn`, `.centerRA`, `.resolution`, `.projectionSystem`
nem `ImageSolver.prototype.Gnomonic`, e **não existe processo core chamado
`ImageSolver`**. Ou seja: esse `eval` **falharia mesmo fora do V8** — a API usada
não existe. Não é regressão do porte; já estava desalinhado.

### Conserto futuro (ponta a ponta)

Fazer os dois lados juntos e só testar depois que o watcher já sobe sob V8:

1. **Lado Node (`agents/llm/deterministic-prep.mjs`):**
   - Reescrever o `eval` para a **API real do engine**: instanciar
     `new ImageSolver()`, popular `solverCfg` (RA/Dec, pixel size, focal,
     resolução, catálogo GaiaDR3, magnitude limite, correção de distorção,
     projeção, etc.) e `metadata`, e chamar `.SolveImage(window)` (conferir a
     assinatura exata na cópia portada). Ler a solução via
     `window.astrometricSolution`.
   - **Remover os acessos `.prototype`** a constantes de processo (ex.:
     `ImageSolver.prototype.Gnomonic`) — no V8, constantes são estáticas na
     classe/objeto, não no `.prototype`. Mapear a projeção para o valor esperado
     pelo `solverCfg` da versão portada.

2. **Lado watcher (`pjsr/pixinsight-mcp-watcher.js`):**
   - Reincluir a **cópia PORTADA** `src/scripts/ImageSolver/ImageSolver.js`
     (tem `#engine v8`, v6.4.2, sem o bug do `toolTip`; puxa deps de
     `<pjsr/astrometry/...>` + arquivos locais `ImageSolverEngine.js` /
     `ImageSolverDialog.js`).
   - Validar o **modo library**: a portada usa `#ifndef USE_SOLVER_LIBRARY` /
     `#undef USE_SOLVER_LIBRARY` — definir `USE_SOLVER_LIBRARY` antes do include,
     como era feito com a AdP.
   - Atenção ao **`#engine v8` aninhado**: a portada tem seu próprio `#engine v8`
     no topo; incluí-la dentro do watcher (que já tem `#engine v8`) pode gerar
     warning de redefinição — verificar se é só warning ou se precisa de
     tratamento.
   - Reintroduzir apenas os defines que a versão portada realmente exigir
     (não trazer de volta os defines mortos removidos na Opção A sem necessidade).

3. **Teste:** só validar o plate solving end-to-end depois que o watcher já
   estiver rodando de forma estável sob V8 e o handshake da bridge funcionar.
