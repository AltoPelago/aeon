import type { EvaluationResult } from './types.js';

export class CandidateQueue {
    private readonly items: EvaluationResult[] = [];

    constructor(private readonly beamWidth: number) {}

    push(result: EvaluationResult): void {
        this.items.push(result);
        this.items.sort((left, right) => right.score - left.score);
        if (this.items.length > this.beamWidth) {
            this.items.length = this.beamWidth;
        }
    }

    shift(): EvaluationResult | undefined {
        return this.items.shift();
    }

    size(): number {
        return this.items.length;
    }
}

