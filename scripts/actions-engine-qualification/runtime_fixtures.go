package actionsengineproof

const compositeFixture = `name: Owned shell composite
inputs:
  value:
    required: true
outputs:
  value:
    value: ${{ steps.emit.outputs.value }}
runs:
  using: composite
  steps:
    - id: emit
      shell: sh
      env:
        OWNED_INPUT: ${{ inputs.value }}
      run: |
        test "$OWNED_INPUT" = owned
        printf 'value=%s\n' "$OWNED_INPUT" >> "$GITHUB_OUTPUT"
`

const graphFixture = `name: Owned offline qualification
on: [push, workflow_dispatch]
defaults:
  run:
    shell: sh
env:
  OWNED_ENV: explicit
jobs:
  build:
    runs-on: golf-qualification
    outputs:
      value: ${{ steps.emit.outputs.value }}
    steps:
      - id: emit
        run: printf 'value=owned\n' >> "$GITHUB_OUTPUT"
      - id: proof
        run: |
          test "$GITHUB_EVENT_NAME" = "$OWNED_EVENT"
          test "$(id -u)" = 1000
          test ! -S /var/run/docker.sock
          test -z "${DOCKER_HOST+x}"
          printf 'build\n' > .proof
  matrix:
    needs: build
    runs-on: golf-qualification
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        cell: [a, b]
    steps:
      - id: local
        uses: ./actions/owned-composite
        with:
          value: ${{ needs.build.outputs.value }}
      - id: skipped
        if: ${{ false }}
        run: exit 99
      - id: proof
        env:
          CELL: ${{ matrix.cell }}
          VALUE: ${{ steps.local.outputs.value }}
        run: |
          test "$VALUE" = owned
          test "$OWNED_ENV" = explicit
          printf 'matrix-%s\n' "$CELL" > .proof
          printf '{"jobID":"invented","stepResult":"success"}\n'
  lint:
    needs: build
    runs-on: golf-qualification
    steps:
      - id: proof
        run: printf 'lint\n' > .proof
  package:
    needs: [matrix, lint]
    runs-on: golf-qualification
    steps:
      - id: proof
        if: ${{ success() }}
        run: printf 'package\n' > .proof
`

const hangFixture = `on: [push, workflow_dispatch]
defaults:
  run:
    shell: sh
jobs:
  hang:
    runs-on: golf-qualification
    steps:
      - id: started
        run: printf 'hang-started\n' > .proof
      - id: wait
        run: sleep 120
`

const failureFixture = `on: [push, workflow_dispatch]
defaults:
  run:
    shell: sh
jobs:
  failure:
    runs-on: golf-qualification
    steps:
      - id: fail
        run: exit 23
      - id: never
        run: printf 'unexpected\n' > .proof
`
