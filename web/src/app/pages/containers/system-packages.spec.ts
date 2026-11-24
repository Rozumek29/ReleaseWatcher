import { TestBed } from '@angular/core/testing';
import { PackageUpdate } from '../../core/models';
import { settle } from '../../testing';
import { SystemPackages, versionDiff } from './system-packages';

describe('versionDiff', () => {
  it('highlights whole changed version components', () => {
    expect(versionDiff('3.0.3', '3.0.4')).toEqual({ same: '3.0.', changed: '4' });
    expect(versionDiff('1.2.9', '1.2.10')).toEqual({ same: '1.2.', changed: '10' });
    expect(versionDiff('2:9.0-1+deb12u1', '2:9.0-1+deb12u2')).toEqual({
      same: '2:9.0-1+',
      changed: 'deb12u2',
    });
    expect(versionDiff('1.0', '2.0')).toEqual({ same: '', changed: '2.0' });
  });

  it('marks everything as changed without an installed version', () => {
    expect(versionDiff(null, '1.0')).toEqual({ same: '', changed: '1.0' });
  });
});

describe('SystemPackages', () => {
  const packages = (count: number): PackageUpdate[] =>
    Array.from({ length: count }, (_, i) => ({
      name: `lib${i}`,
      currentVersion: '1.0.0',
      newVersion: '1.0.1',
    }));

  const create = async (list: PackageUpdate[]) => {
    const fixture = TestBed.createComponent(SystemPackages);
    fixture.componentRef.setInput('packages', list);
    fixture.componentRef.setInput('listId', 1);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  it('shows name, installed and available version with the change emphasised', async () => {
    const { el } = await create([
      { name: 'openssl', currentVersion: '3.0.3', newVersion: '3.0.4' },
    ]);
    const cells = [...el.querySelectorAll('tbody td')].map((td) => td.textContent?.trim());
    expect(cells[0]).toBe('openssl');
    expect(cells[1]).toBe('3.0.3');
    expect(cells[2]).toContain('3.0.4');
    expect(el.querySelector('tbody strong')?.textContent).toBe('4');
    expect(el.querySelector('input')).toBeNull();
  });

  it('filters long lists by package name', async () => {
    const { fixture, el } = await create(packages(12));
    expect(el.querySelectorAll('tbody tr').length).toBe(12);
    expect(el.querySelector('.filter-count')?.textContent).toContain('12 packages');

    const input = el.querySelector<HTMLInputElement>('input[type="search"]')!;
    input.value = 'lib1';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelectorAll('tbody tr').length).toBe(3); // lib1, lib10, lib11
    expect(el.querySelector('.filter-count')?.textContent).toContain('3 of 12');

    input.value = 'nothing';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelector('.none')?.textContent).toContain('No packages match');
  });
});
