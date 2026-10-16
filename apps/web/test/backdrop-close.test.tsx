import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useBackdropClose } from '../src/hooks/useDialog';

function Dialog({ onClose }: { onClose: () => void }) {
  const backdrop = useBackdropClose(onClose);
  return (
    <div data-testid="backdrop" {...backdrop}>
      <div role="dialog"><input aria-label="DB 이름" /></div>
    </div>
  );
}

describe('useBackdropClose', () => {
  it('배경을 눌렀다 떼면 닫는다', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.mouseDown(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('입력칸에서 누른 채 밖으로 끌고 나가 떼면(click 대상이 배경) 닫지 않는다', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    fireEvent.mouseDown(screen.getByLabelText('DB 이름'));
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('대화상자 안을 누르고 떼도 닫지 않는다', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    const input = screen.getByLabelText('DB 이름');
    fireEvent.mouseDown(input);
    fireEvent.click(input);
    expect(onClose).not.toHaveBeenCalled();
  });
});
