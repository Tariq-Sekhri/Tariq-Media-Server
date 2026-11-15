param([int]$Seconds = 120, [string]$OutputPath)
$ErrorActionPreference = 'Stop'
if ($OutputPath) {
    $writer = [System.IO.StreamWriter]::new($OutputPath, $false, [System.Text.UTF8Encoding]::new($false))
    $writer.AutoFlush = $true
    [Console]::SetOut($writer)
}
# Detect only the generated 440 Hz fixture in the render endpoint. No audio
# samples are written to disk; output contains timestamps and signal strength.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RegressionAudio {
 [ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class Enumerator {}
 [ComImport,Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEnum {
  int EnumAudioEndpoints(int flow,int state,out IntPtr collection);
  [PreserveSig]int GetDefaultAudioEndpoint(int flow,int role,out IDevice device);
 }
 [ComImport,Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
  [PreserveSig]int Activate(ref Guid iid,int context,IntPtr parameters,[MarshalAs(UnmanagedType.IUnknown)] out object value);
 }
 [ComImport,Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IClient {
  [PreserveSig]int Initialize(int mode,uint flags,long duration,long periodicity,IntPtr format,IntPtr session);
  int GetBufferSize(out uint frames); int GetStreamLatency(out long latency); int GetCurrentPadding(out uint frames);
  int IsFormatSupported(int mode,IntPtr format,out IntPtr closest);
  [PreserveSig]int GetMixFormat(out IntPtr format);
  int GetDevicePeriod(out long standard,out long minimum);
  [PreserveSig]int Start(); [PreserveSig]int Stop(); int Reset(); int SetEventHandle(IntPtr handle);
  [PreserveSig]int GetService(ref Guid iid,[MarshalAs(UnmanagedType.IUnknown)]out object service);
 }
 [ComImport,Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ICapture {
  [PreserveSig]int GetBuffer(out IntPtr data,out uint frames,out uint flags,out ulong devicePosition,out ulong counterPosition);
  [PreserveSig]int ReleaseBuffer(uint frames);
  [PreserveSig]int GetNextPacketSize(out uint frames);
 }
 static void Check(int hr){Marshal.ThrowExceptionForHR(hr);}
 public static void Run(int seconds) {
  IEnum enumerator=(IEnum)new Enumerator(); IDevice device=null; IClient client=null; ICapture capture=null;IntPtr format=IntPtr.Zero;
  try {
   Check(enumerator.GetDefaultAudioEndpoint(0,0,out device)); object activated;Guid clientId=typeof(IClient).GUID;Check(device.Activate(ref clientId,23,IntPtr.Zero,out activated));client=(IClient)activated;
   Check(client.GetMixFormat(out format));int tag=Marshal.ReadInt16(format,0)&65535,channels=Marshal.ReadInt16(format,2),rate=Marshal.ReadInt32(format,4),align=Marshal.ReadInt16(format,12),bits=Marshal.ReadInt16(format,14);
   if(tag==65534)tag=Marshal.ReadInt32(format,24);
   if(!((tag==3&&bits==32)||(tag==1&&bits==16)))throw new Exception("Unsupported loopback sample format");
   Check(client.Initialize(0,0x20000,10000000,0,format,IntPtr.Zero));object service;Guid captureId=typeof(ICapture).GUID;Check(client.GetService(ref captureId,out service));capture=(ICapture)service;Check(client.Start());
   Console.WriteLine("{\"status\":\"ready\",\"measurement\":\"host-loopback-fixture-tone\"}");Console.Out.Flush();
   DateTime end=DateTime.UtcNow.AddSeconds(seconds);double[] window=new double[2048];int count=0;int diagnostics=0;
   while(DateTime.UtcNow<end){uint available;Check(capture.GetNextPacketSize(out available));if(available==0){Thread.Sleep(5);continue;}
    IntPtr data;uint frames,flags;ulong dp,qp;Check(capture.GetBuffer(out data,out frames,out flags,out dp,out qp));
    try{for(int i=0;i<frames;i++){
     double sample=0;if((flags&2)==0){int offset=i*align;sample=tag==3?BitConverter.ToSingle(BitConverter.GetBytes(Marshal.ReadInt32(data,offset)),0):Marshal.ReadInt16(data,offset)/32768.0;}
     window[count++]=sample;if(count==window.Length){double real=0,imaginary=0,energy=0;for(int n=0;n<count;n++){double angle=2*Math.PI*440*n/rate;real+=window[n]*Math.Cos(angle);imaginary+=window[n]*Math.Sin(angle);energy+=window[n]*window[n];}
      double rms=Math.Sqrt(energy/count),purity=energy>0?2*(real*real+imaginary*imaginary)/(count*energy):0;
      if(diagnostics++<3)Console.WriteLine("{\"status\":\"level\",\"rms\":"+rms.ToString(System.Globalization.CultureInfo.InvariantCulture)+",\"purity\":"+purity.ToString(System.Globalization.CultureInfo.InvariantCulture)+"}");
      if(rms>0.00001&&purity>0.45){long utc=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();Console.WriteLine("{\"status\":\"tone\",\"utcMs\":"+utc+",\"frequencyHz\":440}");Console.Out.Flush();}count=0;
     }
    }}finally{Check(capture.ReleaseBuffer(frames));}
   }
  }finally{if(client!=null)client.Stop();if(format!=IntPtr.Zero)Marshal.FreeCoTaskMem(format);if(capture!=null)Marshal.ReleaseComObject(capture);if(client!=null)Marshal.ReleaseComObject(client);if(device!=null)Marshal.ReleaseComObject(device);Marshal.ReleaseComObject(enumerator);}
 }
}
'@
try { [RegressionAudio]::Run($Seconds) } finally { if ($writer) { $writer.Dispose() } }
