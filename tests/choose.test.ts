import { describe, expect, it } from 'vitest';
import { pickAttack } from '../src/sequence/capture';

const option = (name: string, lands = true, touches = 0): { name: string; lands: boolean; touches: number } => ({ name, lands, touches });

describe('choosing an attack', () => {
  it('alternates between two attacks that are both good', () => {
    const options = [option('slam'), option('sweep')];
    let previous: string | undefined;
    const played: string[] = [];
    for (let i = 0; i < 5; i++) {
      previous = pickAttack(options, previous).name;
      played.push(previous);
    }
    expect(played).toEqual(['slam', 'sweep', 'slam', 'sweep', 'slam']);
  });

  it('never takes an attack that cannot reach the head while another can', () => {
    const options = [option('lunge', false), option('overhand')];
    expect(pickAttack(options, undefined).name).toBe('overhand');
    // Even though it was the one used last time.
    expect(pickAttack(options, 'overhand').name).toBe('overhand');
  });

  it('prefers an attack that sweeps through no bystander, whatever was used before', () => {
    const options = [option('slam'), option('sweep', true, 14)];
    expect(pickAttack(options, 'slam').name).toBe('slam');
    expect(pickAttack(options, undefined).name).toBe('slam');
  });

  it('takes the one that passes through least when every attack passes through someone', () => {
    const options = [option('slam', true, 9), option('sweep', true, 3)];
    expect(pickAttack(options, 'sweep').name).toBe('sweep');
  });

  it('still strikes when nothing reaches the head: the least harm to bystanders, then alternation', () => {
    const options = [option('lunge', false, 0), option('overhand', false, 0)];
    expect(pickAttack(options, 'lunge').name).toBe('overhand');
    expect(pickAttack([option('only', false, 5)], 'only').name).toBe('only');
  });
});
