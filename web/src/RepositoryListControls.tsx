import { useId, useMemo } from 'react';
import { Search, ArrowDownWideNarrow } from 'lucide-react';
import { useLoadedTable, type DataTableColumn } from './DataTable';

type WorkItem = { id: string; number: number; title: string; createdAt: string; updatedAt: string; comments?: number; user?: { login: string } };
export function useRepositoryWorkList<T extends WorkItem>(data: T[], commentSorting = false) {
  const columns = useMemo(() => {
    const columns: DataTableColumn<T>[] = [
    { id: 'search', accessorFn: row => `${row.title} #${row.number} ${row.user?.login || ''}`, enableSorting: false },
    { accessorKey: 'title', enableGlobalFilter: false },
    { accessorKey: 'createdAt', enableGlobalFilter: false },
    { id: 'updatedAt', accessorFn: row => { const time = Date.parse(row.updatedAt); return Number.isFinite(time) ? time : undefined; }, enableGlobalFilter: false, sortFn: 'basic', sortUndefined: 'last' },
    ];
    if (commentSorting) columns.push({ accessorKey: 'comments', enableGlobalFilter: false, sortFn: 'basic', sortUndefined: 'last' });
    return columns;
  }, [commentSorting]);
  const table = useLoadedTable(data, columns, row => row.id);
  const rows = table.getPrePaginatedRowModel().rows.map(row => row.original);
  const order = table.state.sorting[0];
  return { rows, controls: {
    search: String(table.state.globalFilter ?? ''), onSearch: (value: string) => table.setGlobalFilter(value),
    sort: order?.id === 'title' ? 'title' : order?.id === 'updatedAt' ? order.desc ? 'updated-newest' : 'updated-oldest' : order?.id === 'comments' ? order.desc ? 'most-commented' : 'least-commented' : order?.id === 'createdAt' ? order.desc ? 'newest' : 'oldest' : 'provider',
    onSort: (value: string) => table.setSorting(value === 'provider' ? [] : [{ id: value === 'title' ? 'title' : value.startsWith('updated-') ? 'updatedAt' : commentSorting && value.endsWith('-commented') ? 'comments' : 'createdAt', desc: ['newest', 'updated-newest', 'most-commented'].includes(value) }]),
    count: rows.length, total: data.length, commentSorting,
  } };
}

export function RepositoryListControls({ label, search, onSearch, sort, onSort, count, total, commentSorting }: {
  label: string; search: string; onSearch: (value: string) => void; sort: string; onSort: (value: string) => void; count: number; total: number; commentSorting: boolean;
}) {
  const id = useId();
  return <div className="repository-list-controls">
    <div className="search-input"><label className="sr-only" htmlFor={id}>Search loaded {label}</label><Search size={16} aria-hidden="true"/><input id={id} type="search" autoComplete="off" placeholder={`Search loaded ${label}…`} value={search} onChange={event => onSearch(event.target.value)}/></div>
    <label className="repository-sort"><ArrowDownWideNarrow size={16} aria-hidden="true"/><span className="sr-only">Sort loaded {label}</span><select value={sort} onChange={event => onSort(event.target.value)}><option value="provider">Default order</option><option value="newest">Newest</option><option value="oldest">Oldest</option><option value="title">Title</option><option value="updated-newest">Recently updated</option><option value="updated-oldest">Least recently updated</option>{commentSorting ? <><option value="most-commented">Most commented</option><option value="least-commented">Least commented</option></> : null}</select></label>
    <span className="loaded-list-count" aria-live="polite">{count} of {total} loaded</span>
  </div>;
}
