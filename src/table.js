import Toolbox from './toolbox';
import * as $ from './utils/dom';
import throttled from './utils/throttled';

import {
  IconDirectionLeftDown,
  IconDirectionRightDown,
  IconDirectionUpRight,
  IconDirectionDownRight,
  IconCollapse,
  IconCross,
  IconTableWithHeadings,
  IconTableWithoutHeadings,
  IconPlus
} from '@codexteam/icons';

const CSS = {
  wrapper: 'tc-wrap',
  wrapperReadOnly: 'tc-wrap--readonly',
  table: 'tc-table',
  row: 'tc-row',
  rowSelected: 'tc-row--selected',
  cell: 'tc-cell',
  cellHidden: 'tc-cell--hidden',
  cellSelected: 'tc-cell--selected',
  cellSelectedMerge: 'tc-cell--selected-merge',
  addRow: 'tc-add-row',
  addRowDisabled: 'tc-add-row--disabled',
  addColumn: 'tc-add-column',
  addColumnDisabled: 'tc-add-column--disabled',
};

/**
 * @typedef {object} TableConfig
 * @description Tool's config from Editor
 * @property {string[][]} content — two-dimensional array with table contents
 */

/**
 * @typedef {object} TableData - object with the data transferred to form a table
 * @property {number} rows - number of rows in the table
 * @property {number} cols - number of columns in the table
 */


/**
 * Generates and manages table contents.
 */
export default class Table {
  /**
   * Creates
   *
   * @constructor
   * @param {boolean} readOnly - read-only mode flag
   * @param {object} api - Editor.js API
   * @param {TableData} data - Editor.js API
   * @param {TableConfig} config - Editor.js API
   */
  constructor(readOnly, api, data, config) {
    this.readOnly = readOnly;
    this.api = api;
    this.data = this.normalizeTableData(data);
    this.config = config;

    /**
     * DOM nodes
     */
    this.wrapper = null;
    this.table = null;
    this.tableBody = null;

    /**
     * Toolbox for managing of columns
     */
    this.toolboxColumn = this.createColumnToolbox();
    this.toolboxRow = this.createRowToolbox();

    /**
     * Create table and wrapper elements
     */
    this.createTableWrapper();

    // Current hovered row index
    this.hoveredRow = 0;

    // Current hovered column index
    this.hoveredColumn = 0;

    // Boolean indicating whether cells are currently being selected
    this.isSelectingCells = false;
    this.startSelectedRow = null;
    this.startSelectedColumn = null;

    // Index of last selected row via toolbox
    this.selectedRow = 0;

    // Index of last selected column via toolbox
    this.selectedColumn = 0;

    /**
     * Resize table to match config/data size
     */
    this.resize();

    /**
     * Fill the table with data
     */
    this.fill();

    /**
     * The cell in which the focus is currently located, if 0 and 0 then there is no focus
     * Uses to switch between cells with buttons
     */
    this.focusedCell = {
      row: 0,
      column: 0
    };

    /**
     * Global double click listener allows to delegate clicks on some elements
     */
    this.doubleDocumentClicked = () => {
      this.removeSelectedCellStyle();
    }
  
    /**
     * Global click listener allows to delegate clicks on some elements
     */
    this.documentClicked = (event) => {
      const clickedInsideTable = event.target.closest(`.${CSS.table}`) !== null;
      const outsideTableClicked = event.target.closest(`.${CSS.wrapper}`) === null;
      const clickedOutsideToolboxes = clickedInsideTable || outsideTableClicked;

      if (clickedOutsideToolboxes) {
        this.hideToolboxes();
      }

      const clickedOnAddRowButton = event.target.closest(`.${CSS.addRow}`);
      const clickedOnAddColumnButton = event.target.closest(`.${CSS.addColumn}`);

      /**
       * Also, check if clicked in current table, not other (because documentClicked bound to the whole document)
       */
      if (clickedOnAddRowButton && clickedOnAddRowButton.parentNode === this.wrapper) {
        this.addRow(undefined, true);
        this.hideToolboxes();
      } else if (clickedOnAddColumnButton && clickedOnAddColumnButton.parentNode === this.wrapper) {
        this.addColumn(undefined, true);
        this.hideToolboxes();
      }
    };

    if (!this.readOnly) {
      this.bindEvents();
    }
  }

  normalizeTableData(data) {
    const rows = data.content;
    const rowspanTracker = []; // tracks open rowspans for each column

    return {
      ...data,
      content: rows.map((row, rowIndex) => {
        const newCells = [];
        let colIndex = 0;

        for (const cell of row.content) {
          // Insert placeholder cells for open rowspans from previous rows
          while (rowspanTracker[colIndex] > 0) {
            newCells.push({ type: 'placeholder' });
            rowspanTracker[colIndex]--;
            colIndex++;
          }

          const colspan = cell.colspan || 1;
          const rowspan = cell.rowspan || 1;
          newCells.push(cell);
          
          // Add placeholders for colspan > 1
          for (let i = 1; i < colspan; i++) {
            newCells.push({ type: 'placeholder' });
          }

          // Track rowspans for upcoming rows
          if (rowspan > 1) {
            for (let i = 0; i < colspan; i++) {
              rowspanTracker[colIndex + i] = (rowspanTracker[colIndex + i] || 0) + (rowspan - 1);
            }
          }

          colIndex += colspan;
        }

      // Fill placeholders at the end of the row for any remaining open rowspans
        while (rowspanTracker[colIndex] > 0) {
          newCells.push({ type: 'placeholder' });
          rowspanTracker[colIndex]--;
          colIndex++;
        }

        return { ...row, content: newCells };
      }),
    };
  }

  /**
   * Returns the rendered table wrapper
   *
   * @returns {Element}
   */
  getWrapper() {
    return this.wrapper;
  }

  /**
   * Hangs the necessary handlers to events
   */
  bindEvents() {
    // set the listener to close toolboxes when click outside
    document.addEventListener('click', this.documentClicked);

    // set the listener to remove the selected cells on double click
    document.addEventListener('dblclick', this.doubleDocumentClicked);

    // Update toolboxes position depending on the mouse movements
    this.table.addEventListener('mousemove', throttled(150, (event) => this.onMouseMoveInTable(event)), { passive: true });

    // Controls some of the keyboard buttons inside the table
    this.table.onkeypress = (event) => this.onKeyPressListener(event);

    // Tab is executed by default before keypress, so it must be intercepted on keydown
    this.table.addEventListener('keydown', (event) => this.onKeyDownListener(event));

    // Determine the position of the cell in focus
    this.table.addEventListener('focusin', event => this.focusInTableListener(event));

    // Start selecting cells (e.g., for multi-cell operations
    this.table.addEventListener('mousedown', event => this.onMouseDownListener(event));

    // Stop selecting cells
    this.table.addEventListener('mouseup', event => this.onMouseUpListener(event));
  }

  /**
   * Configures and creates the toolbox for manipulating with columns
   *
   * @returns {Toolbox}
   */
  createColumnToolbox() {
    return new Toolbox({
      api: this.api,
      cssModifier: 'column',
      items: [
        {
          label: this.api.i18n.t('Merge cells'),
          icon: IconCollapse,
          hideIf: () => {
            return this.tableBody.querySelectorAll(`.${CSS.cellSelectedMerge}`).length < 2;
          },
          onClick: () => {
            this.mergeCells();
            this.removeSelectedCellStyle();
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Add column to left'),
          icon: IconDirectionLeftDown,
          hideIf: () => {
            return this.numberOfColumns === this.config.maxcols || this.hasMergedColumns();
          },
          onClick: () => {
            this.addColumn(this.selectedColumn, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Add column to right'),
          icon: IconDirectionRightDown,
          hideIf: () => {
            return this.numberOfColumns === this.config.maxcols || this.hasMergedColumns();
          },
          onClick: () => {
            this.addColumn(this.selectedColumn + 1, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Column with headings'), 
          icon: IconTableWithHeadings,
          onClick: () => {
            this.toggleColumnHeadingAttribute(this.selectedColumn, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Column without headings'),
          icon: IconTableWithoutHeadings,
          onClick: () => {
            this.toggleColumnHeadingAttribute(this.selectedColumn, false);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Delete column'),
          icon: IconCross,
          hideIf: () => {
            return this.numberOfColumns === 1;
          },
          confirmationRequired: true,
          onClick: () => {
            this.deleteColumn(this.selectedColumn);
            this.hideToolboxes();
          }
        }
      ],
      onOpen: () => {
        this.selectColumn(this.hoveredColumn);
        this.hideRowToolbox();
      },
      onClose: () => {
        this.unselectColumn();
      }
    });
  }

  /**
   * Configures and creates the toolbox for manipulating with rows
   *
   * @returns {Toolbox}
   */
  createRowToolbox() {
    return new Toolbox({
      api: this.api,
      cssModifier: 'row',
      items: [
        {
          label: this.api.i18n.t('Merge cells'),
          icon: IconCollapse,
          hideIf: () => {
            return this.tableBody.querySelectorAll(`.${CSS.cellSelectedMerge}`).length < 2;
          },
          onClick: () => {
            this.mergeCells();
            this.removeSelectedCellStyle();
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Add row above'),
          icon: IconDirectionUpRight,
          hideIf: () => {
            return this.numberOfRows === this.config.maxrows || this.hasMergedRows();
          },
          onClick: () => {
            this.addRow(this.selectedRow, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Add row below'),
          icon: IconDirectionDownRight,
          hideIf: () => {
            return this.numberOfRows === this.config.maxrows || this.hasMergedRows();
          },
          onClick: () => {
            this.addRow(this.selectedRow + 1, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Row with headings'), 
          icon: IconTableWithHeadings,
          onClick: () => {
            this.toggleRowHeadingAttribute(this.selectedRow, true);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Row without headings'),
          icon: IconTableWithoutHeadings,
          onClick: () => {
            this.toggleRowHeadingAttribute(this.selectedRow, false);
            this.hideToolboxes();
          }
        }, {
          label: this.api.i18n.t('Delete row'),
          icon: IconCross,
          hideIf: () => {
            return this.numberOfRows === 1;
          },
          confirmationRequired: true,
          onClick: () => {
            this.deleteRow(this.selectedRow);
            this.hideToolboxes();
          }
        }
      ],
      onOpen: () => {
        this.selectRow(this.hoveredRow);
        this.hideColumnToolbox();
      },
      onClose: () => {
        this.unselectRow();
      }
    });
  }

  /**
   * Checks if the table contains at least one cell with a rowspan greater than 1.
   *
   * @returns {boolean} Returns `true` if any cell spans multiple rows,
   *                    otherwise `false`.
   */
  hasMergedRows() {
    setTimeout(() => {
      return Array.from(this.tableBody.querySelectorAll(`.${CSS.cellSelected}`))
        .some(cell => cell.rowSpan > 1);
    }, 0);
  }

    /**
   * Checks if the table contains at least one cell with a colspan greater than 1.
   *
   * @returns {boolean} Returns `true` if any cell spans multiple columns,
   *                    otherwise `false`.
   */
  hasMergedColumns() {
    setTimeout(() => {
      return Array.from(this.tableBody.querySelectorAll(`.${CSS.cellSelected}`))
        .some(cell => cell.colSpan > 1);
    }, 0);
  }

  /**
   * When you press enter it moves the cursor down to the next row
   * or creates it if the click occurred on the last one
   */
  moveCursorToNextRow() {
    if (this.focusedCell.row !== this.numberOfRows) {
      this.focusedCell.row += 1;
      this.focusCell(this.focusedCell);
    } else {
      this.addRow();
      this.focusedCell.row += 1;
      this.focusCell(this.focusedCell);
      this.updateToolboxesPosition(0, 0);
    }
  }

  /**
   * Get table cell by row and col index
   *
   * @param {number} row - cell row coordinate
   * @param {number} column - cell column coordinate
   * @returns {HTMLElement}
   */
  getCell(row, column) {
    return this.tableBody.querySelectorAll(`.${CSS.row}:nth-child(${row}) .${CSS.cell}`)[column - 1];
  }

  /**
   * Get table row by index
   *
   * @param {number} row - row coordinate
   * @returns {HTMLElement}
   */
  getRow(row) {
    return this.tableBody.querySelector(`.${CSS.row}:nth-child(${row})`);
  }

  /**
   * The parent of the cell which is the row
   *
   * @param {HTMLElement} cell - cell element
   * @returns {HTMLElement}
   */
  getRowByCell(cell) {
    return cell.parentElement;
  }

  /**
   * Ger row's first cell
   *
   * @param {Element} row - row to find its first cell
   * @returns {Element}
   */
  getRowFirstCell(row) {
    return row.querySelector(`.${CSS.cell}:first-child`);
  }

  /**
   * Set the sell's content by row and column numbers
   *
   * @param {number} row - cell row coordinate
   * @param {number} column - cell column coordinate
   * @param {string} content - cell HTML content
   */
  setCellContent(row, column, content) {
    const cell = this.getCell(row, column);
    if (content.type === 'placeholder') {
      cell.classList.add(CSS.cellHidden);
      return;
    }
    cell.colSpan = content?.colspan ?? 1;
    cell.rowSpan = content?.rowspan ?? 1;
    const cellId = content?.id ?? $.generateRandomKey();
    cell.setAttribute('data-id', cellId);
    cell.innerHTML = this.convertParagraphDataToHtmlString(content.content ?? []);
  }

  /**
   * Converts structured paragraph content objects into an HTML string with <p> tags.
   *
   * @param {Array<Object>} contents - An array of content objects with the following structure:
   *    [
   *      {
   *        id: string | null,        // optional unique identifier
   *        type: 'paragraph',        // content type, expected to be 'paragraph'
   *        data: { text: string }    // text content for the paragraph
   *      }
   *    ]
   * @returns {string} - A single HTML string containing <p> elements with data-id attributes.
   */
  convertParagraphDataToHtmlString(contents) {
    let htmlString = '';

    contents.forEach(content => {
      if (content.type === 'paragraph') {
        const id = content.id || $.generateRandomKey();
        const pTag = this.createParagraph(id);
        pTag.innerHTML = content?.data?.text ?? '&shy;';
        htmlString += pTag.outerHTML;
      }
    });

    return htmlString;
  }

  /**
   * Adds an initial column to the table by iterating through all rows
   * and inserting a new cell into each one.
   *
   * Each newly added cell will contain a paragraph element for text input.
   *
   * @returns {void}
   */
  drawInitialColumn(colIndex) {
    /**
     * Iterate all rows and add a new cell to them for creating a column
     */
    for (let rowIndex = 1; rowIndex <= this.numberOfRows; rowIndex++) {
      const isHeading = this.data?.content?.[rowIndex-1]?.content?.[colIndex]?.heading ?? false;
      const cellElem = this.createCell(isHeading);
      const newParagraph = this.createParagraph();
      cellElem.appendChild(newParagraph);
      this.getRow(rowIndex).appendChild(cellElem);
    }
  };

  /**
   * Add column in table on index place
   * Add cells in each row
   *
   * @param {number} columnIndex - number in the array of columns, where new column to insert, -1 if insert at the end
   * @param {boolean} [setFocus] - pass true to focus the first cell
   */
  addColumn(columnIndex = -1, setFocus = false) {
    let numberOfColumns = this.numberOfColumns;
     /**
      * Check if the number of columns has reached the maximum allowed columns specified in the configuration,
      * and if so, exit the function to prevent adding more columns beyond the limit.
      */
    if (this.config && this.config.maxcols && this.numberOfColumns >= this.config.maxcols) {
      return;
  }
    /**
     * Iterate all rows and add a new cell to them for creating a column
     */
    for (let rowIndex = 1; rowIndex <= this.numberOfRows; rowIndex++) {
      let cell;
      const cellElem = this.createCell();
      const newParagraph = this.createParagraph();
      cellElem.appendChild(newParagraph);

      if (columnIndex > 0 && columnIndex <= numberOfColumns) {
        cell = this.getCell(rowIndex, columnIndex);

        $.insertBefore(cellElem, cell);
      } else {
        cell = this.getRow(rowIndex).appendChild(cellElem);
      }

      /**
       * Autofocus first cell
       */
      if (rowIndex === 1) {
        const firstCell = this.getCell(rowIndex, columnIndex > 0 ? columnIndex : numberOfColumns + 1);

        if (firstCell && setFocus) {
          $.focus(firstCell);
        }
      }
    }

    const addColButton = this.wrapper.querySelector(`.${CSS.addColumn}`);
    if (this.config?.maxcols && this.numberOfColumns > this.config.maxcols - 1 && addColButton ){
      addColButton.classList.add(CSS.addColumnDisabled);
    }
  };

  /**
   * Draws the initial row in the table with the given row content.
   *
   * @param {Object} rowContent - Data used to populate the initial row.
   * @param {string} [rowContent.id] - Optional ID for the row; a random key will be generated if missing or empty.
   * @returns {HTMLElement} row
   */
  drawInitialRow(rowContent) {
    let insertedRow;
    const rowElem = $.make('tr', CSS.row);
    const rowId = rowContent?.id?.trim() ? rowContent.id : $.generateRandomKey();
    rowElem.setAttribute('data-id', rowId);

    /**
     * We remember the number of columns, because it is calculated
     * by the number of cells in the first row
     * It is necessary that the first line is filled in correctly
     */
    const numberOfColumns = this.numberOfColumns;

    insertedRow = this.tableBody.appendChild(rowElem);
    this.fillRow(insertedRow, numberOfColumns);

    return insertedRow;
  };

  /**
   * Add row in table on index place
   *
   * @param {number} index - number in the array of rows, where new column to insert, -1 if insert at the end
   * @param {boolean} [setFocus] - pass true to focus the inserted row
   * @returns {HTMLElement} row
   */
  addRow(index = -1, setFocus = false) {
    let insertedRow;
    const rowElem = $.make('tr', CSS.row);
    rowElem.setAttribute('data-id', $.generateRandomKey());

    /**
     * We remember the number of columns, because it is calculated
     * by the number of cells in the first row
     * It is necessary that the first line is filled in correctly
     */
    const numberOfColumns = this.numberOfColumns;
     /**
      * Check if the number of rows has reached the maximum allowed rows specified in the configuration,
      * and if so, exit the function to prevent adding more columns beyond the limit.
      */  
    if (this.config && this.config.maxrows && this.numberOfRows >= this.config.maxrows && addRowButton) {
      return;
    }

    if (index > 0 && index <= this.numberOfRows) {
      const row = this.getRow(index);

      insertedRow = $.insertBefore(rowElem, row);
    } else {
      insertedRow = this.tableBody.appendChild(rowElem);
    }

    this.fillRow(insertedRow, numberOfColumns);

    const insertedRowFirstCell = this.getRowFirstCell(insertedRow);

    if (insertedRowFirstCell && setFocus) {
      $.focus(insertedRowFirstCell);
    }

    const addRowButton = this.wrapper.querySelector(`.${CSS.addRow}`);
    if (this.config && this.config.maxrows && this.numberOfRows >= this.config.maxrows && addRowButton) {
      addRowButton.classList.add(CSS.addRowDisabled);
    }
    return insertedRow;
  };

  /**
   * Delete a column by index
   *
   * @param {number} index
   */
  deleteColumn(index) {
    for (let i = 1; i <= this.numberOfRows; i++) {
      const cell = this.getCell(i, index);

      if (!cell) {
        return;
      }

      cell.remove();
    }
    const addColButton = this.wrapper.querySelector(`.${CSS.addColumn}`);
    if (addColButton) {
      addColButton.classList.remove(CSS.addColumnDisabled);
    }
  }

  /**
   * Delete a row by index
   *
   * @param {number} index
   */
  deleteRow(index) {
    this.getRow(index).remove();
    const addRowButton = this.wrapper.querySelector(`.${CSS.addRow}`);
    if (addRowButton) {
      addRowButton.classList.remove(CSS.addRowDisabled);
    }
  }

  /**
   * Toggles all cells in a given column between <th> and <td> elements.
   *
   * - Preserves all attributes and content of each cell.
   * - Converts <td> → <th> if `toHeading` is true, otherwise <th> → <td>.
   *
   * @param {number} colIndex - The zero-based index of the column to modify.
   * @param {boolean} [toHeading=false] - If true, converts <td> to <th>; otherwise <th> to <td>.
   */
  toggleColumnHeadingAttribute(colIndex, toHeading = false) {
    const newTagName = toHeading ? 'th' : 'td';

    for (let i = 1; i <= this.numberOfRows; i++) {
      const cell = this.getCell(i, colIndex);
      if (!cell) continue;

      const newElem = document.createElement(newTagName);
      for (let { name, value } of cell.attributes) {
        newElem.setAttribute(name, value);
      }
      newElem.innerHTML = cell.innerHTML;
      cell.replaceWith(newElem);
    }
  }

  /**
   * Toggles all cells in a given table row between <th> and <td> elements.
   *
   * - Preserves all attributes and content of each cell.
   * - Converts <td> → <th> if `toHeading` is true, otherwise <th> → <td>.
   *
   * @param {number} rowIndex - The zero-based index of the row to modify.
   * @param {boolean} [toHeading=false] - If true, converts <td> to <th>; otherwise <th> to <td>.
   */
  toggleRowHeadingAttribute(rowIndex, toHeading = false) {
    const selectedRow = this.getRow(rowIndex);

    const fromTag = toHeading ? 'td' : 'th';
    const toTag = toHeading ? 'th' : 'td';

    selectedRow.querySelectorAll(fromTag).forEach(origElem => {
      const newElem = document.createElement(toTag);
      for (let { name, value } of origElem.attributes) {
        newElem.setAttribute(name, value);
      }
      newElem.innerHTML = origElem.innerHTML;
      origElem.replaceWith(newElem);
    });
  }

  /**
   * Create a wrapper containing a table, toolboxes
   * and buttons for adding rows and columns
   *
   * @returns {HTMLElement} wrapper - where all buttons for a table and the table itself will be
   */
  createTableWrapper() {
    this.wrapper = $.make('div', CSS.wrapper);
    this.table = $.make('table', CSS.table);
    this.tableBody = $.make('tbody');
    this.table.appendChild(this.tableBody);

    if (this.readOnly) {
      this.wrapper.classList.add(CSS.wrapperReadOnly);
    }

    this.wrapper.appendChild(this.toolboxRow.element);
    this.wrapper.appendChild(this.toolboxColumn.element);
    this.wrapper.appendChild(this.table);

    if (!this.readOnly) {
      const addColumnButton = $.make('div', CSS.addColumn, {
        innerHTML: IconPlus
      });
      const addRowButton = $.make('div', CSS.addRow, {
        innerHTML: IconPlus
      });

      this.wrapper.appendChild(addColumnButton);
      this.wrapper.appendChild(addRowButton);
    }
  }

  /**
   * Returns the size of the table based on initial data or config "size" property
   *
   * @return {{rows: number, cols: number}} - number of cols and rows
   */
  computeInitialSize() {
    const content = this.data && this.data.content;
    const isValidArray = Array.isArray(content);
    const contentRows = isValidArray ? content.length : undefined;
    const maxContentLength = content.length ? Math.max(...content.map(item => item.content.length)) : undefined;
    const contentCols = maxContentLength;
    const parsedRows = Number.parseInt(this.config && this.config.rows);
    const parsedCols = Number.parseInt(this.config && this.config.cols);

    /**
     * Value of config have to be positive number
     */
    const configRows = !isNaN(parsedRows) && parsedRows > 0 ? parsedRows : undefined;
    const configCols = !isNaN(parsedCols) && parsedCols > 0 ? parsedCols : undefined;
    const defaultRows = 2;
    const defaultCols = 2;
    const rows = contentRows || configRows || defaultRows;
    const cols = contentCols || configCols || defaultCols;

    return {
      rows: rows,
      cols: cols
    };
  }

  /**
   * Resize table to match config size or transmitted data size
   *
   * @return {{rows: number, cols: number}} - number of cols and rows
   */
  resize() {
    const { rows, cols } = this.computeInitialSize();

    for (let i = 0; i < rows; i++) {
      const rowContent = this.data?.content?.[i];
      this.drawInitialRow(rowContent);
    }

    for (let i = 0; i < cols; i++) {
      this.drawInitialColumn(i);
    }
  }

  /**
   * Fills the table with data passed to the constructor
   *
   * @returns {void}
   */
  fill() {
    const data = this.data;
    const rows = data.content ?? [];
    rows.forEach((row, rowIndex) => {
      const cells = row.content ?? [];
      cells.forEach((cell, cellIndex) => {
        this.setCellContent(rowIndex + 1, cellIndex + 1, cell);
      })
    });
  }

  /**
   * Fills a row with cells
   *
   * @param {HTMLElement} row - row to fill
   * @param {number} numberOfColumns - how many cells should be in a row
   */
  fillRow(row, numberOfColumns) {
    for (let i = 1; i <= numberOfColumns; i++) {
      const newCell = this.createCell();
      const newParagraph = this.createParagraph();
      newCell.appendChild(newParagraph);
      row.appendChild(newCell);
    }
  }

  /**
   * Creating a cell element
   *
   * @return {Element}
   */
  createCell(isHeading = false) {
    const cellTag = isHeading ? 'th' : 'td';
    return $.make(cellTag, CSS.cell,
      {
        colSpan: 1,
        rowSpan: 1,
      },
      {
        id: $.generateRandomKey()
      }
    );
  }

  /**
   * Creating a paragraph element
   *
   * @return {Element}
   */
  createParagraph(id) {
    return $.make('p', undefined,
      {
        contentEditable: !this.readOnly
      },
      {
        id: id ?? $.generateRandomKey()
      }
    );
  }

  /**
   * Get number of rows in the table
   */
  get numberOfRows() {
    return this.tableBody.childElementCount;
  }

  /**
   * Get number of columns in the table
   */
  get numberOfColumns() {
    if (this.numberOfRows) {
      return this.tableBody.querySelectorAll(`.${CSS.row}:first-child .${CSS.cell}`).length;
    }

    return 0;
  }

  /**
   * Is the column toolbox menu displayed or not
   *
   * @returns {boolean}
   */
  get isColumnMenuShowing() {
    return this.selectedColumn !== 0;
  }

  /**
   * Is the row toolbox menu displayed or not
   *
   * @returns {boolean}
   */
  get isRowMenuShowing() {
    return this.selectedRow !== 0;
  }

  /**
   * Start selecting cells (e.g., for multi-cell operations)
   */
  onMouseDownListener() {
    this.isSelectingCells = true;

    if (!this.startSelectedColumn) {
      this.startSelectedColumn = this.hoveredColumn;
    }
    if (!this.startSelectedRow) {
      this.startSelectedRow = this.hoveredRow;
    }
  }

  /**
   * Stop selecting cells
   */
  onMouseUpListener() {
    this.isSelectingCells = false;
    this.startSelectedColumn = null;
    this.startSelectedRow = null;
  }

  /**
   * Add the selected class to a cell if selection mode is active
   * 
   * @param {HTMLElement} element - The cell element to mark as selected
   */
  addSelectedCellStyle(startRow, startColumn, endRow, endColumn) {
    this.removeSelectedCellStyle();
    if (!startRow || !startColumn || !endRow || !endColumn) {
      return;
    }

    const minRow = Math.min(startRow, endRow);
    const maxRow = Math.max(startRow, endRow);
    const minColumn = Math.min(startColumn, endColumn);
    const maxColumn = Math.max(startColumn, endColumn);
    for (let row = minRow; row <= maxRow; row++) {
      for (let column = minColumn; column <= maxColumn; column++) {
        const cell = this.getCell(row, column);
        if (!cell) { continue }
        cell.closest('th, td')?.classList.add(CSS.cellSelectedMerge);
      }
    }
  }

  /**
   * Remove the selected class from all cells, but only if selection mode is not active
   */
  removeSelectedCellStyle() {
    this.selectedCells = [];
    this.tableBody?.querySelectorAll(`.${CSS.cellSelectedMerge}`).forEach(el => el.classList.remove(CSS.cellSelectedMerge));
  }

  /**
   * Recalculate position of toolbox icons
   *
   * @param {Event} event - mouse move event
   */
  onMouseMoveInTable(event) {
    const hoveredCell = event.target.closest('th, td');
    if (!hoveredCell) return;

    const hoveredRow = hoveredCell.closest('tr');
    if (!hoveredRow) return;

    const column = hoveredCell.cellIndex + 1;
    const row = hoveredRow.sectionRowIndex + 1;

    this.hoveredColumn = column;
    this.hoveredRow = row;

    this.updateToolboxesPosition();
    if (this.isSelectingCells) {
      this.addSelectedCellStyle(this.startSelectedRow, this.startSelectedColumn, row, column);
    }
  }

  /**
   * Prevents default Enter behaviors
   * Adds Shift+Enter processing
   *
   * @param {KeyboardEvent} event - keypress event
   */
  onKeyPressListener(event) {
    if (event.key === 'Enter') {
      if (event.shiftKey) {
        return true;
      }

      this.moveCursorToNextRow();
    }

    return event.key !== 'Enter';
  };

  /**
   * Prevents tab keydown event from bubbling
   * so that it only works inside the table
   *
   * @param {KeyboardEvent} event - keydown event
   */
  onKeyDownListener(event) {
    if (event.key === 'Tab') {
      event.stopPropagation();
    }
  }

  /**
   * Set the coordinates of the cell that the focus has moved to
   *
   * @param {FocusEvent} event - focusin event
   */
  focusInTableListener(event) {
    const cell = event.target;
    const row = this.getRowByCell(cell);

    this.focusedCell = {
      row: Array.from(this.tableBody.querySelectorAll(`.${CSS.row}`)).indexOf(row) + 1,
      column: Array.from(row.querySelectorAll(`.${CSS.cell}`)).indexOf(cell) + 1
    };
  }

  /**
   * Unselect row/column
   * Close toolbox menu
   * Hide toolboxes
   *
   * @returns {void}
   */
  hideToolboxes() {
    this.hideRowToolbox();
    this.hideColumnToolbox();
    this.updateToolboxesPosition();
  }

  /**
   * Unselect row, close toolbox
   *
   * @returns {void}
   */
  hideRowToolbox() {
    this.unselectRow();
    this.toolboxRow.hide();
  }
  /**
   * Unselect column, close toolbox
   *
   * @returns {void}
   */
  hideColumnToolbox() {
    this.unselectColumn();

    this.toolboxColumn.hide();
  }

  /**
   * Set the cursor focus to the focused cell
   *
   * @returns {void}
   */
  focusCell() {
    this.focusedCellElem?.focus();
  }

  /**
   * Get current focused element
   *
   * @returns {HTMLElement} - focused cell
   */
  get focusedCellElem() {
    const { row, column } = this.focusedCell;

    return this.getCell(row, column);
  }

  /**
   * Update toolboxes position
   *
   * @param {number} row - hovered row
   * @param {number} column - hovered column
   */
  updateToolboxesPosition(row = this.hoveredRow, column = this.hoveredColumn) {
    if (!this.isColumnMenuShowing) {
      if (column > 0 && column <= this.numberOfColumns) {
        this.toolboxColumn.show(() => {
          return {
            left: `calc((100% - var(--cell-size)) / (${this.numberOfColumns} * 2) * (1 + (${column} - 1) * 2))`
          };
        });
      }
    }

    if (!this.isRowMenuShowing) {
      if (row > 0 && row <= this.numberOfRows) {
        this.toolboxRow.show(() => {
          const hoveredRowElement = this.getRow(row);
          const { fromTopBorder } = $.getRelativeCoordsOfTwoElems(this.tableBody, hoveredRowElement);
          const { height } = hoveredRowElement.getBoundingClientRect();

          return {
            top: `${Math.ceil(fromTopBorder + height / 2)}px`
          };
        });
      }
    }
  }

  convertTabelRowToTableHead() {
    for (let cellIndex = 1; cellIndex <= this.numberOfColumns; cellIndex++) {
      let tdCell = this.getCell(1, cellIndex);
      if (tdCell.tagName !== "TD") {
        return;
      }

      const thCell = document.createElement("th");
      thCell.innerHTML = tdCell.innerHTML;
      for (const attr of tdCell.attributes) {
        thCell.setAttribute(attr.name, attr.value);
      }
      tdCell.parentNode.replaceChild(thCell, tdCell);
    }
  }

  convertTabelHeadToTableRow() {
    for (let cellIndex = 1; cellIndex <= this.numberOfColumns; cellIndex++) {
      let thCell = this.getCell(1, cellIndex);

      if (thCell.tagName !== "TH") {
        return;
      }
      const tdCell = document.createElement("td");
      tdCell.innerHTML = thCell.innerHTML;
      for (const attr of thCell.attributes) {
        tdCell.setAttribute(attr.name, attr.value);
      }
      thCell.parentNode.replaceChild(tdCell, thCell);
    }
  }

  /**
   * Add effect of a selected row
   *
   * @param {number} index
   */
  selectRow(index) {
    const row = this.getRow(index);

    if (row) {
      this.selectedRow = index;
      row.classList.add(CSS.rowSelected);
    }
  }

  /**
   * Remove effect of a selected row
   */
  unselectRow() {
    if (this.selectedRow <= 0) {
      return;
    }

    const row = this.tableBody.querySelector(`.${CSS.rowSelected}`);

    if (row) {
      row.classList.remove(CSS.rowSelected);
    }

    this.selectedRow = 0;
  }

  /**
   * Add effect of a selected column
   *
   * @param {number} index
   */
  selectColumn(index) {
    for (let i = 1; i <= this.numberOfRows; i++) {
      const cell = this.getCell(i, index);

      if (cell) {
        cell.classList.add(CSS.cellSelected);
      }
    }

    this.selectedColumn = index;
  }

  /**
   * Remove effect of a selected column
   */
  unselectColumn() {
    if (this.selectedColumn <= 0) {
      return;
    }

    let cells = this.tableBody.querySelectorAll(`.${CSS.cellSelected}`);

    Array.from(cells).forEach(column => {
      column.classList.remove(CSS.cellSelected);
    });

    this.selectedColumn = 0;
  }

  /**
   * Collects data from cells into a two-dimensional array
   *
   * @returns {string[][]}
   */
  getData() {
    const data = [];

    for (let i = 1; i <= this.numberOfRows; i++) {
      const row = this.tableBody.querySelector(`.${CSS.row}:nth-child(${i})`);
      const rowId = row.getAttribute('data-id') ?? $.generateRandomKey();
      const cells = Array.from(row.querySelectorAll(`.${CSS.cell}`));
      
      data.push({
        id: rowId,
        content: cells.map(cell => {
          if (cell.classList.contains(CSS.cellHidden)) {
            return {
              content: []
            };
          }

          const cellData = {
            id: cell.getAttribute('data-id') || $.generateRandomKey(),
            content: this.extractParagraphData(cell),
          }
          if (cell.tagName === 'TH') {
            cellData.heading = true;
          }
          if (typeof cell.rowSpan === 'number' && cell.rowSpan > 1) {
            cellData.rowspan = cell.rowSpan;
          }
          if (typeof cell.colSpan === 'number' && cell.colSpan > 1) {
            cellData.colspan = cell.colSpan; 
          }
          return cellData;
        }).filter(cell => cell.content.length)
      });
    }
    return data;
  }

  /**
   * Extracts structured paragraph data from a given cell element.
   *
   * @param {HTMLElement} cell - A DOM element containing one or more <p> tags.
   * @returns {Array<Object>} - An array of paragraph objects with the following structure:
   *    [
   *      {
   *        id: string | null,        // value of the data-id attribute on the <p> tag
   *        type: 'paragraph',        // fixed type identifier
   *        data: { text: string }    // inner HTML content of the paragraph
   *      }
   *    ]
   */
  extractParagraphData(cell) {
    const paragraphs = cell.querySelectorAll('p');

    return Array.from(paragraphs).map(paragraph => ({
      id: paragraph.getAttribute('data-id'),
      type: 'paragraph',
      data: { text: paragraph.innerHTML }
    }));
  }

  /**
   * Merge all currently selected table cells into a single cell
   *
   * The merged cell will:
   *  - contain the combined content of all selected cells (joined with <br>)
   *  - expand its rowSpan and colSpan to cover the entire selected rectangle
   *  - hide all other cells that were part of the merge
   *
   * Selection must form a contiguous rectangular block; otherwise, a notification
   * will be shown and the merge will be cancelled
   */
  mergeCells() {
    const selectedCells = Array.from(this.tableBody.querySelectorAll(`.${CSS.cellSelectedMerge}`));
    if (selectedCells.length < 2) return;

    const rows = this.numberOfRows;
    const cols = this.numberOfColumns;

    const matrix = Array.from({ length: rows }, () => new Array(cols).fill(null));

    // Fill the matrix with table cells, considering rowSpan and colSpan and skipping cells hidden by previous merges
    //
    // The matrix represents the visible structure of the table. Each entry points
    // to the corresponding <td>/<th> element, taking into account rowspan and colspan
    //
    // Example 1: simple table without spans
    // <table>
    //   <tr><td>A</td><td>B</td><td>C</td></tr>
    //   <tr><td>D</td><td>E</td><td>F</td></tr>
    // </table>
    //
    // matrix = [
    //   [ A, B, C ],
    //   [ D, E, F ]
    // ]
    // --------------------------------------------------------
    // Example 2: with colSpan
    // <table>
    //   <tr><td colspan="2">A</td><td>B</td></tr>
    //   <tr><td>C</td><td>D</td><td>E</td></tr>
    // </table>
    //
    // matrix = [
    //   [ A, A, B ],   // A spans 2 columns
    //   [ C, D, E ]
    // ]
    // --------------------------------------------------------
    // Example 3: with rowSpan
    // <table>
    //   <tr><td rowspan="2">A</td><td>B</td></tr>
    //   <tr><td>C</td></tr>
    // </table>
    //
    // matrix = [
    //   [ A, B ],
    //   [ A, C ]       // A spans 2 rows
    // ]
    // --------------------------------------------------------
    // Example 4: with both rowSpan and colSpan
    // <table>
    //   <tr><td rowspan="2" colspan="2">A</td><td>B</td></tr>
    //   <tr><td>C</td></tr>
    // </table>
    //
    // matrix = [
    //   [ A, A, B ],
    //   [ A, A, C ]
    // ]
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      let currentColIndex = 0;
      const rowElement = this.getRow(rowIndex + 1);

      for (const cellElement of rowElement.querySelectorAll(`.${CSS.cell}`)) {
        if (!cellElement.classList.contains(CSS.cellHidden)) {

          // find next free column
          const nextFreeColIndex = matrix[rowIndex].findIndex(
            (cell, index) => index >= currentColIndex && !cell
          );
          currentColIndex = nextFreeColIndex >= 0 ? nextFreeColIndex : matrix[rowIndex].length;

          const rowSpan = cellElement.rowSpan ?? 1;
          const colSpan = cellElement.colSpan ?? 1;

          // fill all positions in matrix that this cell covers
          for (let spanRow = 0; spanRow < rowSpan; spanRow++) {
            for (let spanCol = 0; spanCol < colSpan; spanCol++) {
              const targetRow = rowIndex + spanRow;
              const targetCol = currentColIndex + spanCol;
              if (targetRow < rows && targetCol < cols) {
                matrix[targetRow][targetCol] = cellElement;
              }
            }
          }

          currentColIndex += colSpan;
        }
      }
    }

    // Determine positions of the selected cells
    // Example table matrix (after filling with rowSpan/colSpan):
    // [
    //   [ A, B, C ],
    //   [ D, E, F ],
    //   [ G, H, I ]
    // ]
    //
    // Suppose the user selected cells B, E, and H:
    //   +----+----+----+
    //   | A  | X  | C  |
    //   +----+----+----+
    //   | D  | X  | F  |
    //   +----+----+----+
    //   | G  | X  | I  |
    //   +----+----+----+
    //
    // The loop collects their coordinates in the matrix:
    // selectedPositions = [
    //   { row: 0, col: 1 },   // B
    //   { row: 1, col: 1 },   // E
    //   { row: 2, col: 1 }    // H
    // ]
    const selectedSet = new Set(selectedCells);
    const selectedPositions = [];
    for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
      for (let colIndex = 0; colIndex < cols; colIndex++) {
        if (selectedSet.has(matrix[rowIndex][colIndex])) {
          selectedPositions.push({ row: rowIndex, col: colIndex });
        }
      }
    }

    // Calculate bounding rectangle of selected cells
    const minRow = Math.min(...selectedPositions.map(pos => pos.row));
    const maxRow = Math.max(...selectedPositions.map(pos => pos.row));
    const minCol = Math.min(...selectedPositions.map(pos => pos.col));
    const maxCol = Math.max(...selectedPositions.map(pos => pos.col));

    // Validate: check if all cells inside the rectangle are selected or already merged
    //
    // Example 1: valid selection (contiguous rectangle)
    // +----+----+----+
    // | X  | X  |    |
    // +----+----+----+
    // | X  | X  |    |
    // +----+----+----+
    //
    // → All cells in the 2x2 rectangle are selected
    // → Validation passes
    //
    // Example 2: invalid selection (gap inside rectangle)
    // +----+----+----+
    // | X  |    |    |
    // +----+----+----+
    // | X  | X  |    |
    // +----+----+----+
    //
    // Bounding rectangle covers a 2x2 area, but top-right cell is missing
    // → Validation fails
    //
    // Example 3: valid selection with previously merged cells
    // (assume top-left 2x2 block was merged already, hidden cells have 'tc-cell--hidden')
    // +-------------------+----+
    // |          A        | B  |
    // |      (merged)     |    |
    // +-------------------+----+
    // |  tc-cell--hidden  | C  |
    // +----+----+--------------+
    //
    // User selects A and C → rectangle includes hidden cells, but they are ignored
    // → Validation passes
    let invalidSelection = false;
    for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
      for (let colIndex = minCol; colIndex <= maxCol; colIndex++) {
        const cell = matrix[rowIndex][colIndex];
        if (!cell || (!selectedSet.has(cell) && !cell.classList.contains(CSS.cellHidden))) {
          invalidSelection = true;
          break;
        }
      }
      if (invalidSelection) {
        break;
      }
    }
    if (invalidSelection) return

    // Merge the content of all selected cells
    const mergedContent = Array.from(selectedSet)
      .flatMap(cellElement => 
        Array.from(cellElement.querySelectorAll('p')).map(p => p.innerHTML.trim()
      )
    );
    if (!mergedContent.length) return;

    // Define the master cell (top-left) and expand it to cover the rectangle
    //
    // Example: merging a 2x2 block
    //
    // Before merge:
    // +----+----+----+
    // | A  | B  | C  |
    // +----+----+----+
    // | D  | E  | F  |
    // +----+----+----+
    //
    // Selected cells: B, C, E, F
    //
    // After merge:
    // +----+-----------------+
    // | A  |      BCEF       |   <-- masterCell now spans 2x2, contains combined content
    // +----+                 |
    // | D  | tc-cell--hidden |   <-- other cells cleared
    // +----+-----------------+
    const masterCell = matrix[minRow][minCol];
    if (!masterCell) {
      return;
    }

    const newParagraph = this.createParagraph();
    newParagraph.innerHTML = mergedContent.filter((content) => !!content.trim()).join('<br>');
    masterCell.innerHTML = newParagraph.outerHTML;
    masterCell.rowSpan = maxRow - minRow + 1;
    masterCell.colSpan = maxCol - minCol + 1;
    masterCell.classList.remove(CSS.cellHidden);

    // Clear and hide the other merged cells
    selectedSet.forEach(cellElement => {
      if (cellElement !== masterCell) {
        cellElement.innerHTML = '';
        cellElement.classList.add(CSS.cellHidden);
        cellElement.rowSpan = 1;
        cellElement.colSpan = 1;
      }
    });

    this.removeSelectedCellStyle();
  }

  /**
   * Remove listeners on the document
   */
  destroy() {
    document.removeEventListener('click', this.documentClicked);
    document.removeEventListener('dblclick', this.doubleDocumentClicked);
  }
}