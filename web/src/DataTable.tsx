import { useId } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react';
import { columnFilteringFeature, createFilteredRowModel, createPaginatedRowModel, createSortedRowModel, filterFns, globalFilteringFeature, rowPaginationFeature, rowSortingFeature, sortFns, useTable } from '@tanstack/react-table';
import type { ColumnDef, RowData } from '@tanstack/react-table';

const features = { columnFilteringFeature, globalFilteringFeature, rowPaginationFeature, rowSortingFeature, filterFns, sortFns, filteredRowModel: createFilteredRowModel(), sortedRowModel: createSortedRowModel(), paginatedRowModel: createPaginatedRowModel() };
export type DataTableColumn<T extends RowData> = ColumnDef<typeof features, T>;

export function DataTable<T extends RowData>({ data, columns, getRowId, label, emptyMessage = 'No entries.', pagination = true }: {
  data: T[]; columns: DataTableColumn<T>[]; getRowId: (item: T) => string; label: string; emptyMessage?: string; pagination?: boolean;
}) {
  const searchId = useId();
  const pageSizeId = useId();
  const scopeId = useId();
  const table = useTable({ features, data, columns, getRowId, defaultColumn: { sortDescFirst: false, sortFn: 'text' }, globalFilterFn: 'includesString', initialState: { pagination: { pageIndex: 0, pageSize: 20 } }, autoResetPageIndex: true });
  const rows = pagination ? table.getRowModel().rows : table.getPrePaginatedRowModel().rows;
  const search = String(table.state.globalFilter ?? '');
  const filteredCount = table.getPrePaginatedRowModel().rows.length;
  const { pageIndex, pageSize } = table.state.pagination;
  const pageCount = Math.max(1, table.getPageCount());
  const firstRow = filteredCount ? pageIndex * pageSize + 1 : 0;
  const lastRow = Math.min((pageIndex + 1) * pageSize, filteredCount);
  return <div className="data-table-panel">
    <div className="data-table-toolbar"><label htmlFor={searchId}><Search size={16} />Search loaded {label}</label><input id={searchId} type="search" value={search} onChange={(event) => table.setGlobalFilter(event.target.value)} autoComplete="off" placeholder="Filter loaded entries…" /><span className="data-table-count" aria-live="polite">{filteredCount} of {data.length} loaded</span></div>
    <div className="data-table-scroll" tabIndex={0} role="region" aria-label={`${label} table, scroll horizontally when needed`}>
      <table className="data-table" aria-label={label} aria-describedby={scopeId}>
        <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => {
          const sorted = header.column.getIsSorted();
          return <th key={header.id} scope="col" aria-sort={sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined}>
            {header.column.getCanSort() ? <button type="button" className="data-table-sort" onClick={header.column.getToggleSortingHandler()}><table.FlexRender header={header} />{sorted === 'asc' ? <ArrowUp size={14} aria-hidden="true" /> : sorted === 'desc' ? <ArrowDown size={14} aria-hidden="true" /> : <ArrowUpDown size={14} aria-hidden="true" />}</button> : <table.FlexRender header={header} />}
          </th>;
        })}</tr>)}</thead>
        <tbody>{rows.length ? rows.map((row) => <tr key={row.id} data-row-id={row.id}>{row.getAllCells().map((cell) => <td key={cell.id}><table.FlexRender cell={cell} /></td>)}</tr>) : <tr><td colSpan={columns.length} className="data-table-empty">{search && data.length ? 'No loaded entries match your search.' : emptyMessage}</td></tr>}</tbody>
      </table>
    </div>
    {pagination ? <nav className="data-table-pagination" aria-label={`${label} pages`}>
      <label htmlFor={pageSizeId}>Rows per page<select id={pageSizeId} className="data-table-page-size" aria-label={`Rows per page for ${label}`} value={pageSize} onChange={(event) => table.setPagination({ pageIndex: 0, pageSize: Number(event.target.value) })}>{[10, 20, 50].map(size => <option key={size} value={size}>{size}</option>)}</select></label>
      <span className="data-table-page-status" aria-live="polite">Page {pageIndex + 1} of {pageCount}<span>Rows {firstRow}–{lastRow}</span></span>
      <div className="data-table-page-actions"><button type="button" className="button secondary" aria-label="Previous loaded page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</button><button type="button" className="button secondary" aria-label="Next loaded page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</button></div>
      </nav> : null}
    <p id={scopeId} className="data-table-scope">{pagination ? 'Search, sorting and pages cover loaded entries only.' : 'Search and sorting cover all reported entries.'}</p>
  </div>;
}
