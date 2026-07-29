import { render, screen } from '@testing-library/react';
import TempoProgressChip from './TempoProgressChip.jsx';

test('renders nothing when there is no run', () => {
    const { container } = render(<TempoProgressChip progress={null} />);

    expect(container).toBeEmptyDOMElement();
});

test('shows percentage while running', () => {
    render(<TempoProgressChip progress={{ running: true, batchesDone: 41, batchesTotal: 100, failedBatches: 0, added: 1200 }} />);

    expect(screen.getByTestId('tempo-progress')).toHaveTextContent('41%');
});

test('disappears on clean completion', () => {
    // No permanent chrome for a finished job.
    const { container } = render(
        <TempoProgressChip progress={{ running: false, batchesDone: 100, batchesTotal: 100, failedBatches: 0, added: 3000 }} />
    );

    expect(container).toBeEmptyDOMElement();
});

test('stays visible in a warning state when batches failed', () => {
    // Failures must not vanish silently — the column is still incomplete.
    render(<TempoProgressChip progress={{ running: false, batchesDone: 100, batchesTotal: 100, failedBatches: 7, added: 2500 }} />);

    const chip = screen.getByTestId('tempo-progress');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveTextContent(/7/);
});

test('reports how many tempos were added, in its tooltip label', () => {
    render(<TempoProgressChip progress={{ running: true, batchesDone: 10, batchesTotal: 100, failedBatches: 0, added: 400 }} />);

    expect(screen.getByLabelText(/400/)).toBeInTheDocument();
});

test('handles a zero-batch run without dividing by zero', () => {
    const { container } = render(
        <TempoProgressChip progress={{ running: false, batchesDone: 0, batchesTotal: 0, failedBatches: 0, added: 0 }} />
    );

    expect(container).toBeEmptyDOMElement();
});
