// ============================================================
// Pure-JS Feedforward Neural Network (no native dependencies)
//
// Implements:
// - Multi-layer perceptron with configurable hidden layers
// - Backpropagation with mini-batch gradient descent
// - Activations: sigmoid, tanh, leaky-relu
// - Xavier/He weight initialization
// - L2 regularization option
// ============================================================

class NeuralNetwork {
  /**
   * @param {Object} opts
   * @param {number[]} opts.layers - e.g. [13, 16, 8, 3] for 13 inputs, 2 hidden, 3 outputs
   * @param {string}   opts.activation - 'sigmoid' | 'tanh' | 'leaky-relu'
   * @param {number}   opts.learningRate - default 0.01
   * @param {number}   opts.l2Lambda - L2 regularization strength (default 0.0001)
   */
  constructor(opts = {}) {
    this.layers = opts.layers || [13, 16, 8, 3];
    this.activation = opts.activation || 'leaky-relu';
    this.learningRate = opts.learningRate || 0.01;
    this.l2Lambda = opts.l2Lambda || 0.0001;

    // Initialize weights and biases
    this.weights = [];
    this.biases = [];
    for (let i = 0; i < this.layers.length - 1; i++) {
      const fanIn = this.layers[i];
      const fanOut = this.layers[i + 1];
      // He initialization for leaky-relu, Xavier for sigmoid/tanh
      const scale = this.activation === 'leaky-relu'
        ? Math.sqrt(2.0 / fanIn)
        : Math.sqrt(1.0 / fanIn);

      this.weights.push(
        Array.from({ length: fanOut }, () =>
          Array.from({ length: fanIn }, () => (Math.random() * 2 - 1) * scale)
        )
      );
      this.biases.push(Array.from({ length: fanOut }, () => 0));
    }
  }

  // ---- Activation functions ----
  _activate(x) {
    switch (this.activation) {
      case 'sigmoid': return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
      case 'tanh': return Math.tanh(x);
      case 'leaky-relu': return x > 0 ? x : 0.01 * x;
      default: return x > 0 ? x : 0.01 * x;
    }
  }

  _activateDerivative(output) {
    switch (this.activation) {
      case 'sigmoid': return output * (1 - output);
      case 'tanh': return 1 - output * output;
      case 'leaky-relu': return output > 0 ? 1 : 0.01;
      default: return output > 0 ? 1 : 0.01;
    }
  }

  // ---- Forward pass ----
  forward(input) {
    const activations = [input.slice()];

    for (let l = 0; l < this.weights.length; l++) {
      const prev = activations[l];
      const W = this.weights[l];
      const b = this.biases[l];
      const isOutput = l === this.weights.length - 1;

      const layer = [];
      for (let j = 0; j < W.length; j++) {
        let sum = b[j];
        for (let k = 0; k < prev.length; k++) {
          sum += W[j][k] * prev[k];
        }
        // Output layer uses sigmoid for multi-label probability
        layer.push(isOutput ? sigmoid(sum) : this._activate(sum));
      }
      activations.push(layer);
    }

    return activations;
  }

  /**
   * Predict output for given input array.
   * @param {number[]} input
   * @returns {number[]} output values
   */
  run(input) {
    // Guard: clamp any NaN/Infinity in input to 0
    const safeInput = input.map(v => Number.isFinite(v) ? v : 0);
    const activations = this.forward(safeInput);
    const output = activations[activations.length - 1];
    // Guard: clamp output
    return output.map(v => Number.isFinite(v) ? v : 0.5);
  }

  /**
   * Run one step of backpropagation.
   * @param {number[]} input
   * @param {number[]} target
   * @returns {number} error (MSE)
   */
  _backprop(input, target) {
    const activations = this.forward(input);
    const numLayers = this.weights.length;
    const deltas = new Array(numLayers);

    // Output layer deltas (MSE derivative * sigmoid derivative)
    const outputAct = activations[numLayers];
    deltas[numLayers - 1] = outputAct.map((o, i) => {
      const err = o - target[i];
      return err * o * (1 - o); // sigmoid derivative
    });

    // Hidden layer deltas
    for (let l = numLayers - 2; l >= 0; l--) {
      const nextW = this.weights[l + 1];
      const nextDelta = deltas[l + 1];
      const act = activations[l + 1];

      deltas[l] = act.map((a, j) => {
        let sum = 0;
        for (let k = 0; k < nextDelta.length; k++) {
          sum += nextDelta[k] * nextW[k][j];
        }
        return sum * this._activateDerivative(a);
      });
    }

    // Update weights and biases (with gradient clipping)
    const GRAD_CLIP = 5.0;
    for (let l = 0; l < numLayers; l++) {
      const prevAct = activations[l];
      const delta = deltas[l];
      const W = this.weights[l];
      const b = this.biases[l];

      for (let j = 0; j < delta.length; j++) {
        // Clip delta to prevent exploding gradients
        const clippedDelta = Math.max(-GRAD_CLIP, Math.min(GRAD_CLIP, delta[j]));
        for (let k = 0; k < prevAct.length; k++) {
          const grad = clippedDelta * prevAct[k] + this.l2Lambda * W[j][k];
          W[j][k] -= this.learningRate * Math.max(-GRAD_CLIP, Math.min(GRAD_CLIP, grad));
        }
        b[j] -= this.learningRate * clippedDelta;
      }
    }

    // Calculate MSE
    let mse = 0;
    for (let i = 0; i < target.length; i++) {
      const err = outputAct[i] - target[i];
      mse += err * err;
    }
    return mse / target.length;
  }

  /**
   * Train the network on a dataset.
   * @param {Array<{input: number[], output: number[]}>} data
   * @param {Object} opts
   * @param {number} opts.iterations - max epochs (default 500)
   * @param {number} opts.errorThresh - stop if avg MSE below this (default 0.01)
   * @returns {{ error: number, iterations: number }}
   */
  train(data, opts = {}) {
    const maxIter = opts.iterations || 500;
    const errorThresh = opts.errorThresh || 0.01;

    let avgError = Infinity;

    for (let epoch = 0; epoch < maxIter; epoch++) {
      let totalError = 0;

      // Shuffle training data each epoch
      const shuffled = data.slice().sort(() => Math.random() - 0.5);

      for (const sample of shuffled) {
        totalError += this._backprop(sample.input, sample.output);
      }

      avgError = totalError / data.length;

      if (avgError < errorThresh) {
        return { error: avgError, iterations: epoch + 1 };
      }
    }

    return { error: avgError, iterations: maxIter };
  }

  /**
   * Export weights/biases as JSON-serializable object.
   */
  toJSON() {
    return {
      layers: this.layers,
      activation: this.activation,
      learningRate: this.learningRate,
      weights: this.weights,
      biases: this.biases,
    };
  }

  /**
   * Restore from exported JSON.
   */
  static fromJSON(json) {
    const net = new NeuralNetwork({
      layers: json.layers,
      activation: json.activation,
      learningRate: json.learningRate,
    });
    net.weights = json.weights;
    net.biases = json.biases;
    return net;
  }
}

// Standalone sigmoid for output layer
function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x))));
}

module.exports = { NeuralNetwork };
