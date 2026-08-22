# Time Distribution SGV (Standing Genetic Variation)

## Description

Time Distribution SGV computes the distribution of the time to substitution when
the population carries standing variation before selection begins. The model has
two components: an equilibration phase in which variation accumulates, and an
absorption phase in which it can fix. `wfes_sweep` computes the expected time
and rate for this same scenario; this program returns the whole distribution.

Adaptation from standing variation and adaptation from new mutation give
substitution-time distributions that differ in shape as well as in mean, and
they differ most in the early tail, which covers the cases where adaptation is
fast. Because the equilibration phase is modelled explicitly, the population
need not be assumed to have reached its equilibrium frequency distribution when
selection starts.

## Mathematical Model

The model uses two Wright-Fisher components with stochastic switching:

### Component 1: Equilibration
- Non-absorbing boundaries (0 < i < 2N)
- Maintains standing variation at mutation-selection-drift balance
- Parameters: N, s₁, h₁, u₁, v₁

### Component 2: Absorption  
- Absorbing fixation boundary (i = 2N)
- Reflects changed conditions favoring fixation
- Parameters: N, s₂, h₂, u₂, v₂

### Switching Process

Transition rate from equilibration to absorption:
$$\lambda = \frac{1}{\tau}$$

Where τ is the expected time in equilibration before environmental change.

### Time Distribution

The substitution time distribution combines:
1. Time in equilibration phase (exponential with rate λ)
2. Starting frequency distribution from equilibration
3. Fixation time from various starting frequencies

$$f_{sub}(t) = \int f_{equil}(t_1) \, \pi(i \mid equil) \, f_{fix}(t-t_1 \mid i) \, di \, dt_1$$

## Input Parameters

### Required Parameters
- `-N, --pop-size <int>`: Population size (constant across components)
- `-L, --lambda <float>`: Rate of switching from equilibration to absorption

### Component Parameters (comma-separated pairs)
- `-s, --selection <float,float>`: Selection coefficients for components 1,2
- `-h, --dominance <float,float>`: Dominance coefficients (default: 0.5,0.5)  
- `-u, --backward-mu <float,float>`: Backward mutation rates (default: 1e-9,1e-9)
- `-v, --forward-mu <float,float>`: Forward mutation rates (default: 1e-9,1e-9)

### Distribution Parameters
- `-a, --alpha <float>`: Transition-matrix tail truncation (default: 1e-20). Each
  row of the matrix is a binomial distribution over offspring allele counts;
  alpha is the total probability mass trimmed from that row's two tails, alpha/2
  from each, after which the row is renormalised to sum to 1. It is a quantile
  cut rather than a floor on individual entries -- at the default, stored entries
  as small as 1e-43 remain. Raising it makes the matrix sparser and the solve
  faster while discarding real probability mass; values much above 1e-3 are
  refused unless `--force` is given. At the 1e-20 default this is not a no-op: for N=100 it stores 23,015 of the 39,601 entries a fully dense row set would hold, discarding 42% of the entries while removing at most 1e-20 of the mass from each row.
- `-i, --initial <path>`: Initial state distribution, as a CSV column of 4N+1 probabilities over the two concatenated SGV component blocks. It replaces however the starting state would otherwise be set -- a fixed count, or the integration over the copy numbers a new mutation produces -- and is renormalised if it does not sum to 1. A point mass reproduces the corresponding fixed-count run exactly.
- `-d, --distribution-cutoff <float>`: Stop when CDF reaches this value (default: 0.99999)
- `-m, --max-t <int>`: Maximum time to compute (default: 1000000)

If `--max-t` is reached before `-d`'s cutoff, the run has not converged, and
the CDF is left as the raw, un-renormalised partial sum actually reached --
it does not end at 1 -- so the truncation is visible in every output format
rather than disguised as a complete distribution. JSON carries a
`reached_cutoff` field for the same reason, and a warning naming the mass
actually captured is printed to stderr. Only a run that genuinely reaches the
cutoff is normalised to end at exactly 1. When it does, the JSON also
discloses the rescale itself -- `cdf_rescaled: true` alongside
`cdf_pre_rescale_mass`, the captured mass (mirroring `final_cdf`) the CDF was
divided by -- and a cutoff of 0.99 or below additionally prints a one-line
stderr note, since the reported distribution is then conditional on
fixation occurring within the computed window rather than an unconditional
probability. A cutoff already satisfied before
the first generation is refused rather than published as a zero-row
"result". (`-r`/`--no-recurrent-mu` is a flag on other WFES tools but is not
wired into this tool's SGV model, so it is refused here rather than silently
ignored.)

### Computational Parameters
- `-t, --num-threads <int>`: Number of threads
- `--library <string>`: Linear algebra backend: `Pardiso` (Intel MKL; the default on Linux), `Accelerate` (the macOS default), `SuiteSparse`, or `ParU` (parallel SuiteSparse). Note that on macOS `Accelerate` names the matrix backend only: matrices are held in Accelerate format, but the LU factorization and solves are performed by SuiteSparse's UMFPACK. Apple's own sparse solver is used only as a build-time fallback when SuiteSparse is not linked. ViennaCL requires OpenCL support not compiled into the shipped binaries.

### Output Options
- `--json`: Output in JSON format
- `--csv`: Output in CSV format
- `--verbose`: Verbose solver output

Other real flags not detailed here (`--output-Q`, `--output-R`, `--output-P`, `--force`, `-b/--block-size`, `-c/--integration-cutoff`): see `--help`.

## Output Format

### Standard Output
Tab-delimited columns:
```
Time    P(substitution)    CDF
0       0                  0
1       2.4e-6            2.4e-6
2       4.8e-6            7.2e-6
...
```

### JSON Output
```json
{
  "parameters": {
    "N": 1000,
    "lambda": 0.001,
    "components": [
      {"s": -0.001, "h": 0.5, "u": 1e-8, "v": 1e-8},
      {"s": 0.01, "h": 0.5, "u": 1e-8, "v": 1e-8}
    ]
  },
  "statistics": {
    "E_sub": 125000,
    "Var_sub": 1.56e10,
    "substitution_rate": 8e-6
  },
  "distribution": {
    "time": [0, 1, 2, ...],
    "pdf": [0, 2.4e-6, 4.8e-6, ...],
    "cdf": [0, 2.4e-6, 7.2e-6, ...]
  },
  "execution_time": "18.7s"
}
```

## Usage Examples

### Neutral to beneficial transition
```bash
time_dist_sgv -N 1000 -s 0,0.01 -L 0.001
```

### Deleterious to beneficial with mutation
```bash
time_dist_sgv -N 5000 -s -0.002,0.02 -u 1e-8,1e-7 -v 1e-8,1e-7 -L 0.0001
```

### Overdominance to directional selection
```bash
time_dist_sgv -N 1000 -s -0.01,0.01 -h 2.0,0.5 -L 0.001
```

### Long equilibration phase
```bash
time_dist_sgv -N 10000 -s -0.001,0.005 -L 0.00001 -m 100000000
```

## Technical Notes

1. **Component Switching**: Stochastic transition between phases
2. **Frequency Preservation**: Allele frequencies maintained during switch
3. **Standing Variation**: Initial distribution from mutation-selection balance
4. **No Back-Switching**: One-way transition to absorption phase
5. **Efficient Computation**: Exploits sparsity of transition matrices

## Biological Applications

The model covers adaptation from variation already present when conditions change:
alleles held at low frequency under one regime that become beneficial under
another, such as pre-existing resistance alleles, or previously neutral and
deleterious variants. Where adaptation instead waits for a new mutation,
time_dist_dual is the corresponding program.

The single-switch assumption listed below is the main constraint. The environment
changes once, and neither reversion nor gradual change is represented.

## Model Assumptions

1. **Single Switch**: Environment changes once (no reversions)
2. **Instantaneous Change**: No gradual environmental transitions
3. **Equilibrium Start**: Population at mutation-selection-drift balance
4. **Constant Population**: Size doesn't change with environment

## Comparison with Other Models

- **time_dist**: Single environment, no standing variation
- **time_dist_dual**: Waits for new mutations
- **wfes_sweep**: Deterministic switch time
- **time_dist_sgv**: Stochastic switch, realistic for environmental change

The SGV model uniquely captures how standing variation accelerates adaptation under changing conditions.