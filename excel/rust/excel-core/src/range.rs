use crate::cell::CellAddress;

/// A rectangular range of cells, inclusive on both ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CellRange {
    pub start: CellAddress,
    pub end: CellAddress,
}

impl CellRange {
    pub fn new(start: CellAddress, end: CellAddress) -> Self {
        CellRange { start, end }
    }

    /// Single-cell range.
    pub fn single(addr: CellAddress) -> Self {
        CellRange {
            start: addr,
            end: addr,
        }
    }

    /// Normalized bounds — top-left and bottom-right.
    pub fn normalize(&self) -> CellRange {
        CellRange {
            start: CellAddress::new(
                self.start.row.min(self.end.row),
                self.start.col.min(self.end.col),
            ),
            end: CellAddress::new(
                self.start.row.max(self.end.row),
                self.start.col.max(self.end.col),
            ),
        }
    }

    pub fn rows(&self) -> u32 {
        let n = self.normalize();
        n.end.row - n.start.row + 1
    }

    pub fn cols(&self) -> u32 {
        let n = self.normalize();
        n.end.col - n.start.col + 1
    }

    pub fn cell_count(&self) -> u32 {
        self.rows() * self.cols()
    }

    /// Iterate every cell in the range in row-major order.
    pub fn iter(&self) -> impl Iterator<Item = CellAddress> {
        let n = self.normalize();
        let (r0, r1) = (n.start.row, n.end.row);
        let (c0, c1) = (n.start.col, n.end.col);
        (r0..=r1).flat_map(move |r| (c0..=c1).map(move |c| CellAddress::new(r, c)))
    }

    pub fn contains(&self, addr: CellAddress) -> bool {
        let n = self.normalize();
        addr.row >= n.start.row
            && addr.row <= n.end.row
            && addr.col >= n.start.col
            && addr.col <= n.end.col
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iter_row_major() {
        let r = CellRange::new(CellAddress::new(0, 0), CellAddress::new(1, 1));
        let cells: Vec<_> = r.iter().collect();
        assert_eq!(
            cells,
            vec![
                CellAddress::new(0, 0),
                CellAddress::new(0, 1),
                CellAddress::new(1, 0),
                CellAddress::new(1, 1),
            ]
        );
    }

    #[test]
    fn normalize_swaps_corners() {
        let r = CellRange::new(CellAddress::new(3, 4), CellAddress::new(1, 2));
        let n = r.normalize();
        assert_eq!(n.start, CellAddress::new(1, 2));
        assert_eq!(n.end, CellAddress::new(3, 4));
    }

    #[test]
    fn cell_count() {
        let r = CellRange::new(CellAddress::new(0, 0), CellAddress::new(2, 1));
        assert_eq!(r.cell_count(), 6);
    }

    #[test]
    fn contains() {
        let r = CellRange::new(CellAddress::new(1, 1), CellAddress::new(3, 3));
        assert!(r.contains(CellAddress::new(2, 2)));
        assert!(!r.contains(CellAddress::new(0, 0)));
        assert!(r.contains(CellAddress::new(3, 3)));
    }
}
