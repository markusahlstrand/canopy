import {expect,it} from 'vitest';
// @ts-expect-error — the plugin is plain JS, loaded as source by the sandbox in production.
import {workbookFromSheetJS} from '../../../../examples/plugins/univer-office/index.js';
import {pluginCatalog} from './plugin-catalog';

const book=(sheet:Record<string,unknown>,extra:object={})=>workbookFromSheetJS({SheetNames:['Costs'],Sheets:{Costs:sheet},...extra});

it('maps each cell type, keeping formulas and number formats',()=>{
 const {sheets:{sheet1}}=book({
  '!ref':'A1:E1',
  A1:{t:'s',v:'Rent'},B1:{t:'n',v:1200,z:'0.00'},C1:{t:'n',v:2400,f:'B1*2'},D1:{t:'b',v:true},E1:{t:'e',v:7,w:'#DIV/0!'},
 });
 expect(sheet1.name).toBe('Costs');
 expect(sheet1.cellData[0]).toEqual({
  0:{v:'Rent',t:1},1:{v:1200,t:2,s:{n:{pattern:'0.00'}}},2:{v:2400,t:2,f:'=B1*2'},3:{v:1,t:3},4:{v:'#DIV/0!',t:1},
 });
});
it('sizes the grid to the data, so rows past the default grid are not lost',()=>{
 const {sheets:{sheet1}}=book({AB5000:{t:'n',v:1}});
 expect(sheet1.cellData[4999][27]).toEqual({v:1,t:2});
 expect(sheet1).toMatchObject({rowCount:5000,columnCount:28});
});
it('carries merges, column widths and hidden sheets',()=>{
 const wb=book({A1:{t:'s',v:'Title'},'!merges':[{s:{r:0,c:0},e:{r:1,c:3}}],'!cols':[{wpx:140},undefined]},{Workbook:{Sheets:[{Hidden:1}]}});
 expect(wb.sheets.sheet1.mergeData).toEqual([{startRow:0,endRow:1,startColumn:0,endColumn:3}]);
 expect(wb.sheets.sheet1.columnData).toEqual({0:{w:140}});
 expect(wb.sheets.sheet1.hidden).toBe(1);
});
it('keeps one sheet per Excel sheet, in order',()=>{
 const wb=workbookFromSheetJS({SheetNames:['B','A'],Sheets:{B:{},A:{}}});
 expect(wb.sheetOrder).toEqual(['sheet1','sheet2']);
 expect(wb.sheets.sheet2.name).toBe('A');
});
it('is in the catalog with the hosts it loads code from, and matches Excel files',()=>{
 const entry=pluginCatalog.find(row=>row.manifest.id==='univer-office')!;
 expect(entry.manifest.capabilities).toContainEqual({kind:'net:fetch',hosts:['unpkg.com','cdn.sheetjs.com']});
 expect(entry.manifest.contributes!.viewers![0]!.match).toEqual(expect.arrayContaining(['.xls','.xlsx','application/vnd.ms-excel']));
});
