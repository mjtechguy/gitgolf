import { useId } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { columnFilteringFeature, createFilteredRowModel, createSortedRowModel, filterFns, globalFilteringFeature, rowSortingFeature, sortFns, useTable } from '@tanstack/react-table';
import type { ColumnDef, RowData } from '@tanstack/react-table';

const features = { columnFilteringFeature, globalFilteringFeature, rowSortingFeature, filterFns, sortFns, filteredRowModel: createFilteredRowModel(), sortedRowModel: createSortedRowModel() };
export type DataTableColumn<T extends RowData> = ColumnDef<typeof features, T>;

export function DataTable<T extends RowData>({ data, columns, getRowId, label, emptyMessage = 'No entries.' }: {
  data: T[]; columns: DataTableColumn<T>[]; getRowId: (item: T) => string; label: string; emptyMessage?: string;
}) {
  const searchId = useId();
  const table = useTable({ features, data, columns, getRowId, defaultColumn: { sortDescFirst: false, sortFn: 'text' }, globalFilterFn: 'includesString' });
  const rows = table.getRowModel().rows;
  const search = String(table.state.globalFilter ?? '');
  return <div className="data-table-panel">
    <div className="data-table-toolbar"><label htmlFor={searchId}><Search size={16} />Search loaded {label}</label><input id={searchId} type="search" value={search} onChange={(event) => table.setGlobalFilter(event.target.value)} autoComplete="off" placeholder="Filter loaded entries…" /><span className="data-table-count" aria-live="polite">{rows.length} of {data.length} loaded</span></div>
    <div className="data-table-scroll" tabIndex={0} role="region" aria-label={`${label} table, scroll horizontally when needed`}>
      <table className="data-table" aria-label={label}>
        <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => {
          const sorted = header.column.getIsSorted();
          return <th key={header.id} scope="col" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
            {header.column.getCanSort() ? <button className="data-table-sort" onClick={header.column.getToggleSortingHandler()}><table.FlexRender header={header} />{sorted === 'asc' ? <ArrowUp size={14} aria-hidden="true" /> : sorted === 'desc' ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" />}</button> : <table.FlexRender header={header} />}
          </th>;
        })}</tr>)}</thead>
        <tbody>{rows.length ? rows.map((row) => <tr key={row.id} data-row-id={row.id}>{row.getAllCells().map((cell) => <td key={cell.id}><table.FlexRender cell={cell} /></td>)}</tr>) : <tr><td colSpan={columns.length} className="data-table-empty">{search && data.length ? 'No loaded entries match your search.' : emptyMessage}</td></tr>}</tbody>
      </table>
    </div>
  </div>;
}
