# Orientações para agentes

## Entenda o projeto antes de alterar

Adamant é um aplicativo desktop local-first para notas, documentos e contexto de trabalho. A interface usa React, TypeScript e Vite dentro do Tauri 2. O núcleo nativo usa Rust.

- Consulte o [README](README.md) para instalação, funcionalidades e comandos.
- Consulte o [contrato do Vault](docs/vault-contract.md) antes de alterar persistência, formatos, identidade ou recuperação.
- Consulte o [plano de implementação](docs/implementation-plan.md) para o escopo dos marcos. Funcionalidades planejadas não devem ser tratadas como implementadas.
- Verifique `git status` antes de editar. Preserve alterações existentes e não reverta trabalho alheio.

## Mantenha as responsabilidades nos módulos existentes

- `ui/app/`: composição do aplicativo, navegação e estilos da estrutura principal.
- `ui/features/workspace/`: Vaults, documentos abertos, salvamento, conflitos e recuperação.
- `ui/features/work-context/`: workspaces de projeto, Kanban, tarefas locais e itens do GitHub e Jira.
- `ui/features/markdown/`: editor CodeMirror, preservação do texto original e prévia Markdown.
- `ui/features/interaction/`: menus, diálogos e ciclo de animação dos overlays.
- `ui/shared/`: componentes e utilitários compartilhados.
- `native/src/`: comandos Tauri, arquivos, indexação, conexões e credenciais.
- `schemas/`: schemas dos formatos do projeto.
- `scripts/app-update.mjs`: build e instalação local do aplicativo desktop.

Reutilize componentes, tokens e fluxos existentes. Inputs de texto e textareas usam a base global de `ui/shared/styles/inputs.css`. Para campos com ícone, reutilize `.input-field`; mantenha nas features apenas regras de layout e evite recriar bordas, fundos ou foco. Os detalhes dos cards dos Kanbans devem abrir em drawers. Preserve navegação por teclado, retorno do foco, rolagem e respeito a movimento reduzido.

Mantenha o código de cada feature próximo de seus consumidores. `ui/app/` compõe as features. `ui/shared/` contém apenas código reutilizado entre features e não depende delas. Em reorganizações, não introduza arquivos barrel, caminhos de compatibilidade ou novos nomes de IPC.

Mantenha o estado e suas mutações juntos. O coordenador do workspace controla a sessão e a ordem das operações. Paginação, transições de buffers e prompts mantêm seus estados específicos. No núcleo nativo, estenda o mesmo `Vault` com implementações focadas, sem adicionar wrappers de serviço. Carregue o CSS centralmente, com as regras responsivas por último.

Mantenha os testes Markdown junto ao código testado, onde `bun run test:ts` os descobre. Os testes do Vault em Rust permanecem dentro do módulo Vault. Separe declarações e grupos lógicos com linhas em branco.

## Preserve os dados e as fronteiras do produto

- Trate os arquivos do Vault como fonte de verdade. O índice é derivado.
- Preserve os originais PDF e DOCX e os metadados e finais de linha das notas Markdown.
- Mantenha os controles de salvamento, conflitos e recuperação. Não descarte edições para facilitar navegação ou fechamento.
- Mantenha tokens no armazenamento seguro do sistema. Não os grave no Vault, em logs ou em fixtures.
- Separe organização local de estado remoto. Mover um card entre colunas não altera seu status no provedor.
- Preserve ações remotas explícitas e suas confirmações. Não repita escritas automaticamente após falhas ou reconexões.

## Use os comandos do repositório

Use Bun para dependências e scripts. Respeite as versões de `package.json`, `.node-version` e `rust-toolchain.toml`.

- Instale dependências com `bun install --frozen-lockfile`.
- Mantenha `bun.lock` como único lockfile JavaScript. Atualize dependências com `bun add` ou `bun remove`.
- Use `bun run tauri dev` para desenvolvimento desktop.
- Use `bun run dev` para a prévia web. Ela não oferece os recursos nativos nem carrega os dados de workspaces pelo Tauri.
- Execute `bun run test`, não `bun test`. Os testes TypeScript usam o runner do Node e os testes nativos usam Cargo.

## Valide a alteração

Execute as verificações pertinentes antes de entregar:

- Interface: `bun run typecheck`, `bun run lint` e `bun run test:ts`.
- Rust: `bun run lint:rust` e `bun run test:rust`.
- Formatação: `bun run fmt:check`. Use Oxfmt e rustfmt conforme os arquivos alterados.
- Arquivos, exports ou dependências: `bun run knip`.
- Verificação completa antes de integrar: `bun run check`.

Para mudanças visuais, inspecione o componente renderizado e os estados afetados. Diferencie testes de prévia web de testes no desktop e de operações reais nos provedores. Remova fixtures temporárias ao terminar.

## Atualize o app global após cada feature

Toda feature deve terminar com a atualização do aplicativo instalado para o usuário. Depois de validar a implementação, execute na raiz:

```sh
bun run app:update
```

Essa atualização faz parte da entrega e já está autorizada pelo proprietário do repositório. Execute-a sem pedir nova confirmação, salvo instrução contrária do usuário.

Os hooks e o CI não executam `app:update`. Cabe ao agente executar a atualização após validar cada feature.

O comando compila o código local atual em release e instala o executável e o ícone em `${XDG_DATA_HOME:-$HOME/.local/share}/adamant/app/`. O atalho fica em `applications/io.adamant.desktop.desktop` dentro do mesmo diretório de dados. Não use `sudo` nem substitua esse fluxo por cópias manuais.

Aguarde o término e confirme o sucesso da instalação antes de declarar que o app foi atualizado. Se o comando falhar, corrija a causa quando possível e execute novamente. Se houver um impedimento, informe-o e deixe explícito que a atualização não foi concluída.

O comando não reinicia uma instância aberta. Avise que é necessário fechar e reabrir Adamant para usar o novo build. Não encerre uma sessão com possíveis edições pendentes sem autorização.

Atualize o README quando a feature mudar o comportamento documentado. Mantenha este arquivo atualizado quando mudarem os comandos, a estrutura ou as regras de trabalho.
