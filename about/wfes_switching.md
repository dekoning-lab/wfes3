# WFES Switching

## Description

WFES Switching implements the Markov-modulated Wright-Fisher model: several
Wright-Fisher processes are embedded in a Markov chain, and the population moves
among them according to a switching matrix. Parameters that are constant in
`wfes_single` (population size, selection, dominance, mutation rates) can
therefore change over time without the schedule being specified in advance. The
time spent in each regime is geometrically distributed with a mean the user
sets. This is what separates it from `wfes_sequential`, where each epoch runs
for a fixed number of generations, and from `wfes_sweep`, which is the special
case of two regimes with the second one adaptive.

Because the switching structure is part of the transition matrix, absorption
probabilities and times are exact for the time-heterogeneous model, not averages
over separately solved constant-parameter runs. The output decomposes by regime:
where absorption ended, and where the time before it was spent. Environmental
fluctuation, recurring bottlenecks and episodic expansions can be represented
directly, which classical treatments generally cannot do without either fixing
the demographic history or assuming the population is at equilibrium.

## Mathematical Model

The model combines n Wright-Fisher processes Z₁, Z₂, ..., Zₙ with different parameters, connected by a switching process.

### Combined Transition Matrix

$$P = \begin{pmatrix}
Q_1 & \Gamma_{12} & \cdots & \Gamma_{1n} & R_1 \\
\Gamma_{21} & Q_2 & \cdots & \Gamma_{2n} & R_2 \\
\vdots & \vdots & \ddots & \vdots & \vdots \\
\Gamma_{n1} & \Gamma_{n2} & \cdots & Q_n & R_n \\
0 & 0 & \cdots & 0 & I
\end{pmatrix}$$

Where:
- Qᵢ: Transition matrix within state i
- Γᵢⱼ: Switching matrix from state i to j
- Rᵢ: Absorption matrix for state i

### Switching Probabilities

The switching matrix elements are:
$$\Gamma_{ij}(k,l) = \alpha_{ij} \binom{2N_j}{l} \psi_j(k)^l (1-\psi_j(k))^{2N_j-l}$$

Where αᵢⱼ is the switching rate from state i to j.

### Overall Statistics

For starting distribution p = (p₁, p₂, ..., pₙ):
$$P_{fix} = \sum_i p_i \, B(0_i, 2N_i)$$

$$P_{ext} = \sum_i p_i \, B(0_i, 0)$$

## Modes of Operation

### 1. Absorption Mode (--absorption)
Both extinction and fixation are absorbing in all states.

### 2. Fixation Mode (--fixation)  
Only fixation is absorbing; calculates substitution rates.

## Input Parameters

### Required Parameters (comma-separated lists)
- `-N, --pop-sizes <int,...>`: Population sizes for each state
- `-r, --switching <matrix>`: Switching rate matrix (semicolon-separated rows)

### Optional Parameters (comma-separated)
- `-s, --selection <float,...>`: Selection coefficients (default: all 0)
- `-h, --dominance <float,...>`: Dominance coefficients (default: all 0.5)
- `-u, --backward-mu <float,...>`: Backward mutation rates (default: all 1e-9)
- `-v, --forward-mu <float,...>`: Forward mutation rates (default: all 1e-9)
- `-p, --starting-prob <float,...>`: Starting probabilities for each state (default: uniform)

### Computational Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of sum over models of (2N_i - 1) probabilities over the concatenated transient states of all models. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-c, --integration-cutoff <float>`: Starting-copy integration cutoff (default:
  1e-10). Unless the starting state is fixed with `-i, --initial` (a point
  mass), the solver integrates over the number of copies a new mutation
  produces. That distribution is the zero-copy row of the transition matrix
  conditioned on at least one copy arising, and this cutoff truncates its
  tail: starting copy numbers whose probability falls below it are not
  integrated over. It has no effect when `-i` is given, or when the forward
  mutation rate is zero. (`-p, --starting-prob` sets the distribution over
  which *state* the population starts in — a different thing from the
  starting copy number within a state.)

### Execution Parameters
- `--num-threads <int>`: Number of threads
- `--force`: Skip parameter validation
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--output-Q <file>`: Write combined transition matrix
- `--output-R <file>`: Write absorption matrix
- `--csv`: Output in CSV format
- `--json`: Output in JSON format (pending implementation)

## Switching Matrix Format

The switching matrix uses semicolons to separate rows and commas for columns:
```
--switching "0.99,0.01;0.02,0.98"
```

This represents:
$$\begin{pmatrix} 0.99 & 0.01 \\ 0.02 & 0.98 \end{pmatrix}$$

## Output Format

### Absorption Mode Output (CSV)

One row per run. After the echoed parameters come the headline statistics and
the per-state decompositions described above (`0`-indexed by state):

```
N0,N1,s0,s1,...,a,P_ext,P_fix,T_ext,T_fix,P_cond_ext0,P_cond_ext1,P_cond_fix0,P_cond_fix1,T_uncond0,T_uncond1,T_cond_ext0,T_cond_ext1,T_cond_fix0,T_cond_fix1
```

(The previous sample here showed a per-start-state table that the tool has
never produced; starts are integrated over, as described above.)

### Fixation Mode Output  
```
N1,N2,s1,s2,h1,h2,u1,u2,v1,v2,p1,p2,a,T_fix,rate
100,200,0,0.01,0.5,0.5,1e-9,1e-9,1e-9,1e-9,0.5,0.5,1e-20,50000,2e-05
```

## Interpreting the Output

Under `--absorption`, **every model state has both boundaries absorbing** — the
allele can go extinct or fix while the population is in any of the $n$ states,
not only a terminal one.

The headline statistics aggregate over where absorption happens and average
over where the process starts:

- $P_{ext}$, $P_{fix}$: total probability of extinction/fixation, in **any**
  state, averaged over the starting distribution (the state distribution given
  by `-p`, combined with the mutational injection distribution within each
  state). They sum to 1.
- $E[T \mid ext]$, $E[T \mid fix]$: expected total time to absorption,
  conditional on the outcome but **not** on which state it happens in.

The per-state decompositions break these down:

- `P_cond_ext[k]`, `P_cond_fix[k]`: probability of going extinct / fixing
  **while in state $k$**. These sum to $P_{ext}$ and $P_{fix}$ respectively.
- `T_uncond[k]`: expected generations spent in state $k$ before absorption
  (unconditional on the outcome).
- `T_cond_ext[k]`, `T_cond_fix[k]`: expected generations spent in state $k$,
  conditional on extinction / fixation. These sum to $E[T \mid ext]$ and
  $E[T \mid fix]$.

Note that `P_cond_ext` / `P_cond_fix` are **joint** probabilities despite the
`cond` in their names (historical): $P(\text{outcome} \wedge \text{end state } k)$.
The true conditionals are one division away, and the GUI displays them as
derived rows:

- $P(\text{end state } k \mid ext) = P_{cond\_ext}[k] / P_{ext}$ — given
  extinction, where did it happen? (sums to 1)
- $P(ext \mid \text{absorbed in } k) = P_{cond\_ext}[k] / (P_{cond\_ext}[k] + P_{cond\_fix}[k])$

Also note the state index $k$ plays two roles: in the probability
decompositions it is where absorption **ended**; in the time decompositions it
is where time was **spent** en route, conditional on the outcome wherever it
ended.

Nothing is conditioned on the starting state: starts are always integrated
over the `-p` distribution (uniform, $1/n$ per state, when `-p` is omitted).

## Usage Examples

### Two-state reversible switching
```bash
wfes_switching --absorption -N 100,1000 -s 0,0.01 -r "0.99,0.01;0.001,0.999"
```

### Three-state with different selection
```bash
wfes_switching --absorption -N 100,500,1000 -s -0.01,0,0.01 -r "0.98,0.01,0.01;0.02,0.96,0.02;0.01,0.01,0.98"
```

### Non-reversible switching (ratchet)
```bash
wfes_switching --fixation -N 100,200 -r "0.99,0.01;0,1" -p "1,0"
```

### With mutation rate variation
```bash
wfes_switching --absorption -N 1000,1000 -u 1e-8,1e-6 -v 1e-8,1e-6 -r "0.999,0.001;0.001,0.999"
```

## Technical Notes

1. **State Matching**: Allele frequencies are preserved when switching between states with different N
2. **Matrix Dimension**: Combined matrix size is Σ(2Nᵢ-1) for absorption mode
3. **Reversibility**: Switching can be reversible or non-reversible
4. **Starting Distribution**: Can specify non-uniform starting probabilities
5. **Sparse Implementation**: Uses block-sparse structure for efficiency

## Biological Applications

The switching model represents one population whose parameters change over time:
size changes that recur irregularly, selection that varies with the environment,
or mutation rates that differ between regimes. Any process that can be written as
a set of parameter regimes with transition probabilities between them fits,
provided it acts on a single locus in a single population. The model has no
second population, so migration and population structure are outside it.

The result comes from linear algebra on the exact chain, so rare outcomes are
computed to the same precision as common ones; resolving them by simulation would
require a large number of replicates.

